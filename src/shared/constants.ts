/** Constantes compartilhadas entre service worker, content script, popup e opções. */

export const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

/**
 * Escopos mínimos:
 *  - playlist-read-private / playlist-read-collaborative: listar as playlists do usuário;
 *  - playlist-modify-private / playlist-modify-public: adicionar faixas (a API aceita qualquer
 *    um dos dois conforme a visibilidade da playlist) e criar playlists.
 * A busca de faixas não exige escopo próprio (apenas um token de usuário válido).
 */
export const SPOTIFY_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
] as const;

/** Limite máximo de `limit` na busca (Development Mode, fev/2026). */
export const SEARCH_LIMIT = 10;
export const PLAYLIST_PAGE_SIZE = 50;
export const MAX_PLAYLISTS = 500;
/** Máximo de itens que varremos em uma playlist para detectar duplicatas. */
export const MAX_DUPLICATE_SCAN_ITEMS = 1000;

/** Sites em que o content script é injetado por padrão (devem coincidir com o manifest). */
export const BUILTIN_MATCHES = [
  'https://www.youtube.com/*',
  'https://music.youtube.com/*',
  'https://soundcloud.com/*',
  'https://*.bandcamp.com/*',
  'https://www.deezer.com/*',
  'https://listen.tidal.com/*',
  'https://music.apple.com/*',
] as const;

export const SEARCH_CACHE_MAX_ENTRIES = 150;
export const SEARCH_CACHE_TTL_FOUND_MS = 7 * 24 * 60 * 60 * 1000;
export const SEARCH_CACHE_TTL_MISS_MS = 30 * 60 * 1000;
export const PLAYLISTS_CACHE_TTL_MS = 5 * 60 * 1000;
/** Espera após a mídia mudar antes de pesquisar (evita buscar títulos ainda "velhos" do DOM). */
export const SEARCH_SETTLE_MS = 1200;

export const SCORE_HIGH = 0.8;
export const SCORE_MEDIUM = 0.62;
export const SCORE_MIN = 0.45;
/** Abaixo de SCORE_MIN mas acima disto: "pouco provável" — mostrada só se não houver nada melhor. */
export const SCORE_WEAK = 0.2;
