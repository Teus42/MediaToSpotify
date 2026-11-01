import type { ErrorInfo, MediaInfo, PlaylistSummary, SearchOutcome, SpotifyUser } from './types';

/* ---------- content script -> service worker ---------- */

export type ContentMessage = { type: 'media:update'; media: MediaInfo } | { type: 'media:gone' };

/* ---------- popup/opções -> service worker ---------- */

export type SearchPhase = 'idle' | 'searching' | 'done' | 'error';

export interface Snapshot {
  tabId: number | null;
  media: MediaInfo | null;
  search: {
    phase: SearchPhase;
    outcome?: SearchOutcome;
    error?: ErrorInfo;
    /** Link para pesquisa manual no Spotify (não exige login). */
    manualSearchUrl?: string;
  };
  auth: {
    configured: boolean;
    connected: boolean;
    user?: SpotifyUser;
  };
}

export interface AddResult {
  status: 'added' | 'duplicate';
  playlistName: string;
  /** `skipped` quando a playlist era grande demais para verificar duplicatas. */
  duplicateCheck: 'done' | 'skipped';
}

export interface PlaylistsResult {
  playlists: PlaylistSummary[];
  fetchedAt: number;
}

export interface SiteEntry {
  origin: string;
}

export type Request =
  | { type: 'snapshot:get'; tabId?: number }
  | { type: 'search:retry'; tabId?: number }
  | { type: 'auth:login' }
  | { type: 'auth:logout' }
  | { type: 'playlists:list'; refresh?: boolean }
  | { type: 'playlists:add'; playlistId: string; trackUri: string; allowDuplicate?: boolean }
  | { type: 'playlists:create'; name: string; isPublic: boolean; trackUri?: string }
  | { type: 'sites:enable'; origin: string; tabId?: number }
  | { type: 'sites:disable'; origin: string }
  | { type: 'sites:list' }
  | { type: 'cache:clear' };

export interface ResponseMap {
  'snapshot:get': Snapshot;
  'search:retry': Snapshot;
  'auth:login': { user?: SpotifyUser };
  'auth:logout': null;
  'playlists:list': PlaylistsResult;
  'playlists:add': AddResult;
  'playlists:create': { playlist: PlaylistSummary; added: boolean };
  'sites:enable': null;
  'sites:disable': null;
  'sites:list': SiteEntry[];
  'cache:clear': null;
}

export type Response<T> = { ok: true; data: T } | { ok: false; error: ErrorInfo };
