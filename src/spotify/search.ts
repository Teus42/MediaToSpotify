import { SCORE_HIGH, SEARCH_LIMIT } from '../shared/constants';
import type { SearchOutcome, SpotifyTrack } from '../shared/types';
import { buildQueries } from '../matching/queries';
import { rankTracks, scoreTrack } from '../matching/ranking';
import type { ParsedQuery } from '../metadata/title-parser';
import type { SpotifyClient } from './client';

interface RawImage {
  url?: string;
  width?: number | null;
}

interface RawTrack {
  id?: string;
  uri?: string;
  name?: string;
  duration_ms?: number;
  explicit?: boolean;
  is_playable?: boolean;
  external_urls?: { spotify?: string };
  artists?: Array<{ name?: string } | null>;
  album?: { name?: string; album_type?: string; images?: RawImage[] } | null;
}

interface SearchResponse {
  tracks?: { items?: Array<RawTrack | null> };
}

/** Escolhe a menor capa com pelo menos ~150 px (boa para o popup, barata de baixar). */
export function pickImage(images: RawImage[] | undefined, minWidth = 150): string | undefined {
  const usable = (images ?? []).filter((i): i is RawImage & { url: string } => !!i?.url);
  if (usable.length === 0) return undefined;
  const sorted = [...usable].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= minWidth) ?? sorted[sorted.length - 1])?.url;
}

/** Valida e converte um item da API. A API pode devolver `null` ou campos ausentes. */
export function mapTrack(raw: RawTrack | null | undefined): SpotifyTrack | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  const artists = (raw.artists ?? []).map((a) => a?.name).filter((n): n is string => !!n);
  const track: SpotifyTrack = {
    id: raw.id,
    uri: raw.uri ?? `spotify:track:${raw.id}`,
    name: raw.name,
    artists,
    album: raw.album?.name ?? '',
    durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : 0,
    url: raw.external_urls?.spotify ?? `https://open.spotify.com/track/${raw.id}`,
  };
  if (raw.album?.album_type) track.albumType = raw.album.album_type;
  const art = pickImage(raw.album?.images);
  if (art) track.albumArtUrl = art;
  if (typeof raw.explicit === 'boolean') track.explicit = raw.explicit;
  if (typeof raw.is_playable === 'boolean') track.isPlayable = raw.is_playable;
  return track;
}

/** Deriva o mercado (ISO 3166-1 alpha-2) da configuração ou do idioma do navegador. */
export function resolveMarket(setting: string | undefined, language: string | undefined): string | undefined {
  const explicit = setting?.trim().toUpperCase();
  if (explicit && /^[A-Z]{2}$/.test(explicit)) return explicit;
  const region = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(language ?? '')?.[1];
  return region ? region.toUpperCase() : undefined;
}

export interface SearchOptions {
  market?: string;
  durationSec?: number;
  now?: () => number;
}

/**
 * Pesquisa a faixa no Spotify. Tenta consultas da mais específica para a mais ampla e para
 * assim que encontra uma correspondência de confiança alta (a maioria das mídias = 1 requisição).
 */
export async function searchTrack(client: SpotifyClient, parsed: ParsedQuery, options: SearchOptions = {}): Promise<SearchOutcome> {
  const queries = buildQueries(parsed);
  const pool = new Map<string, SpotifyTrack>();
  const sent: string[] = [];
  const perQuery: Array<{ q: string; returned: number }> = [];
  let ranked = rankTracks([], parsed);

  for (const q of queries) {
    sent.push(q);
    const res = await client.get<SearchResponse>('/search', {
      q,
      type: 'track',
      limit: SEARCH_LIMIT,
      market: options.market,
    });
    perQuery.push({ q, returned: (res.tracks?.items ?? []).filter(Boolean).length });
    for (const raw of res.tracks?.items ?? []) {
      const track = mapTrack(raw);
      if (track && !pool.has(track.id)) pool.set(track.id, track);
    }
    ranked = rankTracks([...pool.values()], parsed, { durationSec: options.durationSec });
    if ((ranked[0]?.score ?? 0) >= SCORE_HIGH) break;
  }

  const outcome: SearchOutcome = {
    status: ranked.length > 0 ? 'found' : 'not-found',
    matches: ranked,
    queries: sent,
    searchedAt: (options.now ?? Date.now)(),
  };
  // Diagnóstico sempre que a correspondência não é firme (nada achado, ou só palpites).
  if (ranked.length === 0 || ranked[0]?.confidence === 'weak' || ranked[0]?.confidence === 'low') {
    const top = [...pool.values()]
      .map((t) => ({ name: t.name, artists: t.artists, durationMs: t.durationMs, score: Math.round(scoreTrack(t, parsed, { durationSec: options.durationSec }) * 1000) / 1000 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    outcome.debug = {
      queries: perQuery,
      top,
      readings: parsed.candidates.map((c) => (c.artist ? { title: c.title, artist: c.artist } : { title: c.title })),
      ...(options.market ? { market: options.market } : {}),
    };
  }
  return outcome;
}
