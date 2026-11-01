import { MAX_DUPLICATE_SCAN_ITEMS, MAX_PLAYLISTS, PLAYLIST_PAGE_SIZE } from '../shared/constants';
import { AppError } from '../shared/errors';
import type { PlaylistSummary, SpotifyUser } from '../shared/types';
import type { SpotifyClient } from './client';
import { pickImage } from './search';

/*
 * Endpoints (documentação atual, após as mudanças de fev/2026 para apps em Development Mode):
 *   GET  /me                          perfil
 *   GET  /me/playlists                playlists do usuário (limit máx. 50)
 *   POST /me/playlists                cria playlist (substitui POST /users/{id}/playlists)
 *   POST /playlists/{id}/items        adiciona itens (substitui /tracks)
 *   GET  /playlists/{id}/items        itens da playlist (só para playlists do usuário/colaborativas)
 */

interface RawPlaylist {
  id?: string;
  name?: string;
  collaborative?: boolean;
  images?: Array<{ url?: string; width?: number | null }> | null;
  owner?: { id?: string; display_name?: string } | null;
  // Após fev/2026 o campo é `items`; `tracks` está obsoleto mas ainda pode aparecer.
  items?: { total?: number } | null;
  tracks?: { total?: number } | null;
}

interface PagingResponse<T> {
  items?: Array<T | null>;
  next?: string | null;
  total?: number;
}

export async function getMe(client: SpotifyClient): Promise<SpotifyUser> {
  const me = await client.get<{ id?: string; display_name?: string }>('/me');
  if (!me.id) throw new AppError('api', 'Resposta inesperada do Spotify ao carregar o perfil.');
  return me.display_name ? { id: me.id, displayName: me.display_name } : { id: me.id };
}

export function mapPlaylist(raw: RawPlaylist | null | undefined, userId: string): PlaylistSummary | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  const collaborative = raw.collaborative === true;
  const total = raw.items?.total ?? raw.tracks?.total;
  const summary: PlaylistSummary = {
    id: raw.id,
    name: raw.name,
    collaborative,
    editable: raw.owner?.id === userId || collaborative,
  };
  const image = pickImage(raw.images ?? undefined, 60);
  if (image) summary.imageUrl = image;
  if (typeof total === 'number') summary.trackCount = total;
  const owner = raw.owner?.display_name ?? raw.owner?.id;
  if (owner) summary.ownerName = owner;
  return summary;
}

/** Carrega todas as playlists (paginando de 50 em 50, até MAX_PLAYLISTS). */
export async function listPlaylists(client: SpotifyClient, userId: string): Promise<PlaylistSummary[]> {
  const out: PlaylistSummary[] = [];
  for (let offset = 0; offset < MAX_PLAYLISTS; offset += PLAYLIST_PAGE_SIZE) {
    const page = await client.get<PagingResponse<RawPlaylist>>('/me/playlists', { limit: PLAYLIST_PAGE_SIZE, offset });
    for (const raw of page.items ?? []) {
      const mapped = mapPlaylist(raw, userId);
      if (mapped) out.push(mapped);
    }
    if (!page.next) break;
  }
  return out;
}

export async function createPlaylist(client: SpotifyClient, userId: string, name: string, isPublic: boolean): Promise<PlaylistSummary> {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError('bad-request', 'Informe um nome para a playlist.');
  const raw = await client.post<RawPlaylist>('/me/playlists', {
    name: trimmed.slice(0, 100),
    public: isPublic,
    description: 'Criada pela extensão Media to Spotify',
  });
  const mapped = mapPlaylist(raw, userId);
  if (!mapped) throw new AppError('api', 'Resposta inesperada do Spotify ao criar a playlist.');
  return { ...mapped, editable: true };
}

export async function addTrackToPlaylist(client: SpotifyClient, playlistId: string, trackUri: string): Promise<void> {
  if (!/^spotify:track:[A-Za-z0-9]+$/.test(trackUri)) throw new AppError('bad-request', 'URI de faixa inválido.');
  await client.post(`/playlists/${encodeURIComponent(playlistId)}/items`, { uris: [trackUri] });
}

export type ContainsResult = 'yes' | 'no' | 'unknown';

interface RawPlaylistEntry {
  item?: { uri?: string } | null;
  track?: { uri?: string } | null; // nome antigo do campo
}

/**
 * Verifica se a faixa já está na playlist. Só é confiável para playlists pequenas/médias
 * (varremos até MAX_DUPLICATE_SCAN_ITEMS itens); caso contrário ou se a API negar a leitura,
 * devolve 'unknown' — a interface então simplesmente não afirma nada.
 */
export async function playlistContainsTrack(
  client: SpotifyClient,
  playlistId: string,
  trackUri: string,
  knownTotal?: number,
): Promise<ContainsResult> {
  if (knownTotal !== undefined && knownTotal > MAX_DUPLICATE_SCAN_ITEMS) return 'unknown';
  try {
    for (let offset = 0; offset < MAX_DUPLICATE_SCAN_ITEMS; offset += PLAYLIST_PAGE_SIZE) {
      const page = await client.get<PagingResponse<RawPlaylistEntry>>(`/playlists/${encodeURIComponent(playlistId)}/items`, {
        limit: PLAYLIST_PAGE_SIZE,
        offset,
        additional_types: 'track',
      });
      for (const entry of page.items ?? []) {
        if ((entry?.item?.uri ?? entry?.track?.uri) === trackUri) return 'yes';
      }
      if (!page.next) return 'no';
    }
    return 'unknown';
  } catch (err) {
    if (err instanceof AppError && (err.kind === 'forbidden' || err.kind === 'not-found' || err.kind === 'bad-request')) {
      return 'unknown';
    }
    throw err;
  }
}
