import type { Snapshot } from '../shared/messages';
import type { ErrorInfo, PlaylistSummary, Settings, SpotifyTrack } from '../shared/types';

export interface TabContext {
  tabId?: number;
  origin?: string;
  /** http(s) e não é página interna do Chrome/Web Store. */
  injectable: boolean;
  /** O site já está na lista de compatíveis (content script permanente). */
  builtin: boolean;
  /** O usuário já habilitou o site permanentemente. */
  customEnabled: boolean;
}

export type AddStatus = 'idle' | 'adding' | 'done';

/** Resultado da tentativa de salvar a faixa em UMA playlist. */
export interface AddResultItem {
  playlistId: string;
  playlistName: string;
  status: 'added' | 'duplicate' | 'error';
  error?: ErrorInfo;
}

export interface State {
  loaded: boolean;
  snapshot: Snapshot | null;
  settings: Settings | null;
  fatal?: ErrorInfo;
  matchIndex: number;
  matchKey: string;
  appOpenAttempted: boolean;
  connecting: boolean;
  connectError?: ErrorInfo;
  retrying: boolean;
  tab: TabContext;
  siteNotice?: string;
  panel: 'closed' | 'playlists';
  playlists: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    items: PlaylistSummary[];
    error?: ErrorInfo;
    filter: string;
    /** Playlists marcadas (é possível salvar em várias de uma vez). */
    selectedIds: string[];
    /** O usuário mexeu na seleção: não sobrescrever com a pré-seleção. */
    touched: boolean;
  };
  /** Playlists onde a última faixa foi salva (vem do storage). */
  lastPlaylistIds: string[];
  create: { open: boolean; name: string; isPublic: boolean; busy: boolean };
  add: { status: AddStatus; results: AddResultItem[] };
}

export interface Actions {
  connect(): void;
  retrySearch(): void;
  openSettings(): void;
  listen(track: SpotifyTrack): void;
  openWeb(track: SpotifyTrack): void;
  selectMatch(index: number): void;
  openPlaylistPanel(): void;
  closePlaylistPanel(): void;
  refreshPlaylists(): void;
  setFilter(value: string): void;
  /** Marca/desmarca uma playlist. */
  selectPlaylist(id: string): void;
  confirmAdd(allowDuplicate: boolean): void;
  toggleCreate(): void;
  setCreateName(value: string): void;
  setCreatePublic(value: boolean): void;
  createAndAdd(): void;
  detectHere(): void;
  alwaysHere(): void;
  openManualSearch(url: string): void;
}

export function initialState(): State {
  return {
    loaded: false,
    snapshot: null,
    settings: null,
    matchIndex: 0,
    matchKey: '',
    appOpenAttempted: false,
    connecting: false,
    retrying: false,
    tab: { injectable: false, builtin: false, customEnabled: false },
    panel: 'closed',
    playlists: { status: 'idle', items: [], filter: '', selectedIds: [], touched: false },
    lastPlaylistIds: [],
    create: { open: false, name: '', isPublic: false, busy: false },
    add: { status: 'idle', results: [] },
  };
}
