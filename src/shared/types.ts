/** Tipos de domínio compartilhados. Tudo aqui é serializável (trafega por mensagens/storage). */

export type PlaybackState = 'playing' | 'paused' | 'ended';

/** De onde veio o título (ordem de prioridade decrescente). */
export type TitleSource = 'site' | 'mediasession' | 'element' | 'document';

export interface MediaInfo {
  title: string;
  artist?: string;
  album?: string;
  /** Canal/uploader (ex.: YouTube). Pista mais fraca que `artist`. */
  channel?: string;
  /** Apenas o host — não guardamos a URL completa da página. */
  host: string;
  playback: PlaybackState;
  durationSec?: number;
  source: TitleSource;
  artworkUrl?: string;
  updatedAt: number;
}

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  artists: string[];
  album: string;
  albumType?: string;
  albumArtUrl?: string;
  durationMs: number;
  /** Link oficial (open.spotify.com). */
  url: string;
  explicit?: boolean;
  /** Só presente quando a API recebe um mercado. `false` = indisponível na região. */
  isPlayable?: boolean;
}

export type Confidence = 'high' | 'medium' | 'low' | 'weak';

export interface ScoredMatch {
  track: SpotifyTrack;
  /** 0..1 */
  score: number;
  confidence: Confidence;
}

/** Diagnóstico mostrado em "Detalhes técnicos" quando nada é encontrado. */
export interface SearchDebug {
  queries: Array<{ q: string; returned: number }>;
  /** Melhores candidatas vistas (mesmo abaixo do limite), com a nota que receberam. */
  top: Array<{ name: string; artists: string[]; durationMs: number; score: number }>;
  /** Leituras do título usadas na pontuação. */
  readings: Array<{ title: string; artist?: string }>;
  market?: string;
}

export interface SearchOutcome {
  status: 'found' | 'not-found';
  matches: ScoredMatch[];
  /** Consultas enviadas ao Spotify (úteis para depurar e para a busca manual). */
  queries: string[];
  searchedAt: number;
  debug?: SearchDebug;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  imageUrl?: string;
  trackCount?: number;
  /** Do usuário ou colaborativa — apenas essas aceitam novas faixas. */
  editable: boolean;
  collaborative: boolean;
  ownerName?: string;
}

export type ErrorKind =
  | 'not-configured' // Client ID ausente
  | 'unauthenticated' // sem sessão / sessão expirada
  | 'auth-denied' // usuário recusou ou fechou a janela
  | 'auth-failed' // state inválido, troca de código falhou etc.
  | 'network'
  | 'rate-limit'
  | 'forbidden' // 403: escopo, Premium/Development Mode, playlist sem permissão
  | 'not-found'
  | 'bad-request'
  | 'api'
  | 'internal';

export interface ErrorInfo {
  kind: ErrorKind;
  message: string;
  retryAfterSec?: number;
  status?: number;
}

export interface Settings {
  clientId: string;
  autoSearch: boolean;
  /** Como "Ouvir no Spotify" tenta abrir a faixa. */
  openMode: 'app' | 'web';
  /** Código ISO 3166-1 alpha-2; vazio = derivar do idioma do navegador. */
  market: string;
}

export const DEFAULT_SETTINGS: Settings = {
  clientId: '',
  autoSearch: true,
  openMode: 'app',
  market: '',
};

export interface SpotifyUser {
  id: string;
  displayName?: string;
}
