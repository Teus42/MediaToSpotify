import type { ErrorInfo, MediaInfo, PlaylistSummary, SearchOutcome, Settings, SpotifyUser } from './types';
import { DEFAULT_SETTINGS } from './types';

/**
 * Acesso tipado ao chrome.storage.
 *
 *  - `local`: configurações, sessão Spotify, cache. Por padrão o chrome.storage.local só é
 *    acessível por contextos confiáveis da extensão (service worker, popup, opções) — NÃO pelos
 *    content scripts, que rodam dentro das páginas.
 *  - `session`: estado efêmero por aba (some ao fechar o navegador); sobrevive à suspensão do
 *    service worker, que é o motivo de não guardarmos esse estado em variáveis.
 */

export interface StoredAuth {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
  scope: string;
  /** Client ID com o qual o token foi emitido. */
  clientId: string;
}

export interface CachedSearch {
  outcome: SearchOutcome;
  at: number;
}

export interface TabEntry {
  media: MediaInfo;
  /** Última vez em que a mídia estava tocando (para escolher a aba "atual"). */
  lastPlayingAt: number;
}

export interface SearchState {
  phase: 'searching' | 'error';
  at: number;
  error?: ErrorInfo;
}

export interface LocalSchema {
  settings: Partial<Settings>;
  auth: StoredAuth;
  user: SpotifyUser;
  searchCache: Record<string, CachedSearch>;
  playlistsCache: { playlists: PlaylistSummary[]; fetchedAt: number };
  customSites: string[];
  /** IDs das playlists onde a última faixa foi salva (pré-seleção na próxima vez). */
  lastPlaylists: string[];
}

export interface SessionSchema {
  tabs: Record<string, TabEntry>;
  searchState: Record<string, SearchState>;
  /** Janela de rate limit global (epoch ms). */
  rateLimitedUntil: number;
}

export async function getLocal<K extends keyof LocalSchema>(key: K): Promise<LocalSchema[K] | undefined> {
  const res = await chrome.storage.local.get(key);
  return res[key] as LocalSchema[K] | undefined;
}

export async function setLocal<K extends keyof LocalSchema>(key: K, value: LocalSchema[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function removeLocal(...keys: (keyof LocalSchema)[]): Promise<void> {
  await chrome.storage.local.remove(keys);
}

export async function getSession<K extends keyof SessionSchema>(key: K): Promise<SessionSchema[K] | undefined> {
  const res = await chrome.storage.session.get(key);
  return res[key] as SessionSchema[K] | undefined;
}

export async function setSession<K extends keyof SessionSchema>(key: K, value: SessionSchema[K]): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export async function getSettings(): Promise<Settings> {
  const stored = await getLocal('settings');
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await setLocal('settings', next);
  return next;
}
