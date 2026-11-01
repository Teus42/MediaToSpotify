import { getLocal, getSettings, removeLocal, setLocal } from '../shared/storage';
import type { SpotifyUser } from '../shared/types';
import { AuthService } from '../spotify/auth';
import { SpotifyClient } from '../spotify/client';
import { getMe } from '../spotify/playlists';
import { updateBadges } from './badge';
import { PlaylistService } from './playlist-service';
import { SearchService } from './search-service';
import type { Services } from './router';

/**
 * Montagem das dependências no service worker. Como o Chrome pode suspender e reiniciar o worker
 * a qualquer momento, nada aqui guarda estado importante: tokens, cache e estado das abas ficam
 * em chrome.storage, e estes objetos são apenas "fiação" recriada a cada despertar.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createServices(): Services {
  const auth = new AuthService({
    getSettings,
    loadAuth: () => getLocal('auth'),
    saveAuth: (a) => setLocal('auth', a),
    clearAll: () => removeLocal('auth', 'user', 'playlistsCache', 'lastPlaylists'),
    getRedirectUrl: () => chrome.identity.getRedirectURL(),
    launchWebAuthFlow: (details) => chrome.identity.launchWebAuthFlow(details),
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    // O Chrome pode suspender o worker durante a janela de login; um ping periódico o mantém vivo.
    keepAlive: () => {
      const id = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
      return () => clearInterval(id);
    },
  });

  const client = new SpotifyClient({
    fetch: (...args) => fetch(...args),
    getAccessToken: () => auth.getAccessToken(),
    refreshAccessToken: () => auth.forceRefresh(),
    sleep,
  });

  const ensureUser = async (): Promise<SpotifyUser> => {
    const stored = await getLocal('user');
    if (stored) return stored;
    const me = await getMe(client);
    await setLocal('user', me);
    return me;
  };

  const search = new SearchService({
    getSettings,
    isConnected: () => auth.isConnected(),
    client,
    now: () => Date.now(),
    language: () => navigator.language,
    onResult: (key, outcome) => void updateBadges(key, outcome),
  });

  const playlists = new PlaylistService({ client, getUser: ensureUser, now: () => Date.now() });

  return { auth, search, playlists, ensureUser, now: () => Date.now() };
}
