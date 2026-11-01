/**
 * Classificação de resultados do Spotify.
 *
 * Níveis: alta ≥ 0,8; média ≥ 0,62; baixa ≥ 0,45; pouco provável ≥ 0,2 (abaixo disso, descartada).
 * O objetivo é NÃO assumir que "título parecido" significa "mesma música": o score combina
 * título, artista, versão (live/remix/karaokê…), duração e disponibilidade, e candidatos fracos
 * são descartados em vez de apresentados como correspondência.
 */

import { SCORE_HIGH, SCORE_MEDIUM, SCORE_MIN, SCORE_WEAK } from '../shared/constants';
import type { Confidence, ScoredMatch, SpotifyTrack } from '../shared/types';
import { fold, similarity } from '../metadata/text';
import { analyzeTrackName, type ParsedQuery, type Variant } from '../metadata/title-parser';

export interface RankOptions {
  /** Duração da mídia original (s), quando conhecida e finita. */
  durationSec?: number;
  maxResults?: number;
}

const KARAOKE_LIKE = /\b(karaoke|tribute|made famous|originally performed|in the style of|cover version|8-bit|lullaby|piano tribute)\b/i;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function artistScore(trackArtists: string[], wanted: string): number {
  // Sem lista de artistas na resposta (campo ausente), não punimos: o dado simplesmente não existe.
  if (trackArtists.length === 0) return 0.6;
  const joined = trackArtists.join(' ');
  return Math.max(similarity(joined, wanted), ...trackArtists.map((a) => similarity(a, wanted)));
}

function containsFolded(haystack: string, needle: string): boolean {
  const n = fold(needle);
  return n.length >= 2 && ` ${fold(haystack)} `.includes(` ${n} `);
}

function variantPenalty(wanted: ReadonlySet<Variant>, got: ReadonlySet<Variant>): number {
  let penalty = 0;
  for (const v of got) {
    if (wanted.has(v)) continue;
    penalty += v === 'remaster' ? 0.02 : 0.14;
  }
  for (const v of wanted) {
    if (!got.has(v)) penalty += v === 'remaster' ? 0 : 0.08;
  }
  return penalty;
}

function durationAdjustment(durationSec: number | undefined, trackMs: number): number {
  if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0 || trackMs <= 0) return 0;
  const diff = Math.abs(durationSec - trackMs / 1000);
  if (diff <= 2) return 0.08;
  if (diff <= 5) return 0.05;
  if (diff <= 15) return 0.02;
  // Vídeos têm introduções/créditos; só penaliza diferenças grandes.
  if (diff > Math.max(45, durationSec * 0.3)) return -0.06;
  return 0;
}

export function scoreTrack(track: SpotifyTrack, parsed: ParsedQuery, options: RankOptions, index = 0): number {
  const analysis = analyzeTrackName(track.name);
  const wantedVariants = new Set<Variant>(parsed.variants);
  const gotVariants = new Set<Variant>(analysis.variants);

  const primaryArtistInRaw = track.artists.some((a) => containsFolded(parsed.rawTitle, a));
  const channelHit = parsed.channelArtist ? artistScore(track.artists, parsed.channelArtist) : 0;
  const featuredHit =
    parsed.featured.length > 0 &&
    parsed.featured.some((f) => track.artists.some((a) => similarity(a, f) >= 0.85) || containsFolded(track.name, f));

  let best = 0;
  for (const cand of parsed.candidates) {
    const t = similarity(analysis.core, cand.title);
    let base: number;
    if (cand.artist) {
      const a = artistScore(track.artists, cand.artist);
      base = 0.6 * t + 0.4 * a;
      // Artista errado com título idêntico costuma ser cover/homônimo: derruba bastante.
      if (a < 0.4) base *= 0.6;
    } else {
      const hit = primaryArtistInRaw || channelHit >= 0.85 ? 1 : channelHit >= 0.6 ? 0.6 : 0;
      base = 0.55 * t + 0.45 * hit; // sem artista conhecido, só chega a "alta" se o artista aparecer no título/canal
    }
    if (t < 0.5) base *= 0.5; // o título precisa se parecer; só o artista não basta
    best = Math.max(best, base * cand.weight);
  }

  let score = best;
  if (featuredHit) score += 0.03;
  score += durationAdjustment(options.durationSec, track.durationMs);
  score -= variantPenalty(wantedVariants, gotVariants);

  const albumAndArtists = `${track.album} ${track.artists.join(' ')} ${track.name}`;
  if (KARAOKE_LIKE.test(albumAndArtists) && !KARAOKE_LIKE.test(parsed.rawTitle)) score -= 0.25;
  if (track.albumType === 'compilation') score -= 0.02;
  if (track.isPlayable === false) score -= 0.2;
  score += Math.max(0, 10 - index) * 0.001; // desempate pela ordem de relevância do Spotify

  return clamp01(score);
}

export function confidenceOf(score: number): Confidence | null {
  if (score >= SCORE_HIGH) return 'high';
  if (score >= SCORE_MEDIUM) return 'medium';
  if (score >= SCORE_MIN) return 'low';
  if (score >= SCORE_WEAK) return 'weak';
  return null;
}

/** Duas faixas são "a mesma" quando têm mesmo núcleo, artista principal e duração próxima. */
function duplicateKey(track: SpotifyTrack): string {
  const core = fold(analyzeTrackName(track.name).core);
  const artist = fold(track.artists[0] ?? '');
  return `${core}|${artist}|${Math.round(track.durationMs / 3000)}`;
}

/**
 * Pontua, filtra os candidatos fracos, remove duplicatas (mesma gravação em álbuns diferentes,
 * mantendo a de melhor score) e ordena.
 */
export function rankTracks(tracks: SpotifyTrack[], parsed: ParsedQuery, options: RankOptions = {}): ScoredMatch[] {
  const scored: Array<ScoredMatch & { index: number }> = [];
  tracks.forEach((track, index) => {
    const score = scoreTrack(track, parsed, options, index);
    const confidence = confidenceOf(score);
    if (confidence) scored.push({ track, score, confidence, index });
  });

  const byKey = new Map<string, ScoredMatch & { index: number }>();
  for (const item of scored) {
    const key = duplicateKey(item.track);
    const current = byKey.get(key);
    if (!current || item.score > current.score + 1e-9) byKey.set(key, item);
  }

  const durationSec = options.durationSec;
  const dist = (t: SpotifyTrack) =>
    durationSec && Number.isFinite(durationSec) ? Math.abs(durationSec - t.durationMs / 1000) : 0;

  const sorted = [...byKey.values()].sort((a, b) => b.score - a.score || dist(a.track) - dist(b.track) || a.index - b.index);
  // "Pouco provável" só aparece quando não há nada melhor (evita poluir a lista de alternativas).
  const strong = sorted.filter((m) => m.confidence !== 'weak');
  return (strong.length > 0 ? strong : sorted)
    .slice(0, options.maxResults ?? 3)
    .map(({ track, score, confidence }) => ({ track, score: Math.round(score * 1000) / 1000, confidence }));
}
