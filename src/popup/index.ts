import { BUILTIN_MATCHES } from '../shared/constants';
import { mediaKey } from '../shared/media-key';
import { matchesAny } from '../shared/match-pattern';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { ErrorInfo, SpotifyTrack } from '../shared/types';
import { ApiError, send } from './api';
import { withFocusPreserved } from './dom';
import { initialState, type Actions, type AddResultItem, type State } from './state';
import { renderApp } from './views';

/**
 * Popup. É só interface: não guarda tokens nem fala com a API do Spotify — tudo passa por
 * mensagens ao service worker, que é o único contexto com acesso às credenciais.
 */

const POLL_MS = 1500;
const state: State = initialState();
const root = document.getElementById('app') as HTMLElement;
let lastSnapshotJson = '';
let busy = 0; // operações em andamento: pausam o polling para não sobrescrever o estado

function render(): void {
  withFocusPreserved(() => root.replaceChildren(renderApp(state, actions)));
}

function asErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof ApiError) return err.info;
  return { kind: 'internal', message: err instanceof Error ? err.message : String(err) };
}

/* ---------------- aba ativa ---------------- */

async function loadTabContext(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = { injectable: false, builtin: false, customEnabled: false, tabId: tab?.id };
  const url = tab?.url; // visível porque o popup foi aberto por clique (activeTab)
  if (!url || !/^https?:\/\//i.test(url)) return;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  // A Chrome Web Store e páginas internas não aceitam scripts de extensões.
  const blocked = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
  const sites = await send({ type: 'sites:list' }).catch(() => []);
  state.tab = {
    tabId: tab?.id,
    origin,
    injectable: !blocked,
    builtin: matchesAny(url, BUILTIN_MATCHES),
    customEnabled: sites.some((s) => s.origin === origin),
  };
}

/* ---------------- atualização do estado ---------------- */

async function refresh(): Promise<void> {
  if (busy > 0) return;
  try {
    const snap = await send({ type: 'snapshot:get', tabId: state.tab.tabId });
    const json = JSON.stringify(snap);
    state.fatal = undefined;
    if (!state.loaded || json !== lastSnapshotJson) {
      lastSnapshotJson = json;
      state.snapshot = snap;
      state.loaded = true;
      const key = snap.media ? mediaKey(snap.media) : '';
      if (key !== state.matchKey) {
        // Outra mídia: zera escolhas locais.
        state.matchKey = key;
        state.matchIndex = 0;
        state.appOpenAttempted = false;
        state.add = { status: 'idle', results: [] };
      }
      if (snap.auth.connected) state.connectError = undefined;
      render();
    }
  } catch (err) {
    state.fatal = asErrorInfo(err);
    state.loaded = true;
    render();
  }
}

async function guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
  busy++;
  try {
    return await fn();
  } finally {
    busy--;
  }
}

function currentTrack(): SpotifyTrack | undefined {
  const outcome = state.snapshot?.search.outcome;
  if (!outcome || outcome.matches.length === 0) return undefined;
  return outcome.matches[Math.min(state.matchIndex, outcome.matches.length - 1)]?.track;
}

/* ---------------- abrir no Spotify ---------------- */

const SPOTIFY_WEB = /^https:\/\/open\.spotify\.com\//;

function openWebUrl(url: string): void {
  if (!SPOTIFY_WEB.test(url)) return; // os links vêm da API, mas só abrimos o domínio oficial
  void chrome.tabs.create({ url });
}

/** Pede ao Chrome para tratar o URI spotify: (abre o app se o SO tiver um manipulador). */
function launchProtocol(uri: string): void {
  if (!/^spotify:track:[A-Za-z0-9]+$/.test(uri)) return;
  const a = document.createElement('a');
  a.href = uri;
  a.style.display = 'none';
  document.body.append(a);
  a.click(); // gesto do usuário (clique no botão) → o Chrome mostra o aviso "Abrir Spotify?"
  a.remove();
}

/* ---------------- playlists ---------------- */

async function loadPlaylists(refresh: boolean): Promise<void> {
  state.playlists.status = 'loading';
  state.playlists.error = undefined;
  render();
  await guarded(async () => {
    try {
      const res = await send({ type: 'playlists:list', refresh });
      state.playlists.items = res.playlists;
      state.playlists.status = 'ready';
      // Remove da seleção playlists que não existem mais e aplica a pré-seleção.
      state.playlists.selectedIds = state.playlists.selectedIds.filter((id) => res.playlists.some((p) => p.id === id && p.editable));
      applyPreselection();
    } catch (err) {
      state.playlists.status = 'error';
      state.playlists.error = asErrorInfo(err);
    }
  });
  render();
}

/**
 * Pré-seleciona as playlists onde a última faixa foi salva — mas só se o usuário ainda não mexeu
 * na seleção e elas continuam existindo e editáveis.
 */
function applyPreselection(): void {
  const pl = state.playlists;
  if (pl.touched || pl.selectedIds.length > 0) return;
  pl.selectedIds = state.lastPlaylistIds.filter((id) => pl.items.some((p) => p.id === id && p.editable));
}

/** Salva a faixa em cada playlist informada, uma a uma, guardando o resultado de cada. */
async function addToMany(ids: string[], retryDuplicates: boolean): Promise<void> {
  const track = currentTrack();
  if (!track || ids.length === 0) return;
  const results: AddResultItem[] = retryDuplicates ? [...state.add.results] : state.add.results.filter((r) => r.status === 'added');
  state.add = { status: 'adding', results };
  render();
  await guarded(async () => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as string;
      const name = state.playlists.items.find((p) => p.id === id)?.name ?? '';
      let item: AddResultItem;
      try {
        const res = await send({ type: 'playlists:add', playlistId: id, trackUri: track.uri, allowDuplicate: retryDuplicates });
        item = { playlistId: id, playlistName: res.playlistName || name, status: res.status };
        if (res.status === 'added') {
          state.playlists.items = state.playlists.items.map((p) => (p.id === id ? { ...p, trackCount: (p.trackCount ?? 0) + 1 } : p));
        }
      } catch (err) {
        const info = asErrorInfo(err);
        item = { playlistId: id, playlistName: name, status: 'error', error: info };
        // Limite de requisições ou sessão expirada: tentar as demais só pioraria.
        if (info.kind === 'rate-limit' || info.kind === 'unauthenticated') {
          mergeResult(results, item);
          for (const restId of ids.slice(i + 1)) {
            mergeResult(results, { playlistId: restId, playlistName: state.playlists.items.find((p) => p.id === restId)?.name ?? '', status: 'error', error: info });
          }
          break;
        }
      }
      mergeResult(results, item);
    }
    state.add = { status: 'done', results: [...results] };
    await rememberSaved(results);
  });
  render();
}

function mergeResult(results: AddResultItem[], item: AddResultItem): void {
  const at = results.findIndex((r) => r.playlistId === item.playlistId);
  if (at >= 0) results[at] = item;
  else results.push(item);
}

/** Guarda onde a faixa foi salva, para pré-selecionar na próxima vez. */
async function rememberSaved(results: AddResultItem[]): Promise<void> {
  const saved = results.filter((r) => r.status === 'added').map((r) => r.playlistId);
  if (saved.length === 0) return;
  state.lastPlaylistIds = saved;
  try {
    await setLocal('lastPlaylists', saved);
  } catch {
    /* preferência é só conveniência */
  }
}

/* ---------------- ações ---------------- */

const actions: Actions = {
  connect() {
    state.connecting = true;
    state.connectError = undefined;
    render();
    // Obs.: a janela de login do Spotify tira o foco do popup e o Chrome o fecha. O login continua
    // no service worker; ao reabrir o popup, o estado "Conectado" aparece.
    void guarded(async () => {
      try {
        await send({ type: 'auth:login' });
      } catch (err) {
        state.connectError = asErrorInfo(err);
      } finally {
        state.connecting = false;
      }
    }).then(async () => {
      lastSnapshotJson = '';
      await refresh();
      render();
    });
  },

  retrySearch() {
    state.retrying = true;
    render();
    void guarded(async () => {
      try {
        const snap = await send({ type: 'search:retry', tabId: state.tab.tabId });
        state.snapshot = snap;
        lastSnapshotJson = JSON.stringify(snap);
      } catch (err) {
        state.connectError = asErrorInfo(err);
      } finally {
        state.retrying = false;
      }
    }).then(render);
  },

  openSettings() {
    void chrome.runtime.openOptionsPage();
  },

  async listen(track) {
    const settings = state.settings ?? (await getSettings());
    if (settings.openMode === 'web') {
      openWebUrl(track.url);
      return;
    }
    launchProtocol(track.uri);
    state.appOpenAttempted = true;
    render();
  },

  openWeb(track) {
    openWebUrl(track.url);
  },

  openManualSearch(url) {
    openWebUrl(url);
  },

  selectMatch(index) {
    state.matchIndex = index;
    state.appOpenAttempted = false;
    state.add = { status: 'idle', results: [] };
    render();
  },

  openPlaylistPanel() {
    state.panel = 'playlists';
    state.add = { status: 'idle', results: [] };
    render();
    document.getElementById('h-pl')?.scrollIntoView({ block: 'start' });
    if (state.playlists.status === 'idle' || state.playlists.status === 'error') void loadPlaylists(false);
    else {
      applyPreselection();
      render();
    }
  },

  closePlaylistPanel() {
    state.panel = 'closed';
    render();
  },

  refreshPlaylists() {
    void loadPlaylists(true);
  },

  setFilter(value) {
    state.playlists.filter = value;
    render();
  },

  selectPlaylist(id) {
    const pl = state.playlists;
    pl.touched = true;
    pl.selectedIds = pl.selectedIds.includes(id) ? pl.selectedIds.filter((x) => x !== id) : [...pl.selectedIds, id];
    render();
  },

  confirmAdd(allowDuplicate) {
    const { results } = state.add;
    const ids = allowDuplicate
      ? results.filter((r) => r.status === 'duplicate').map((r) => r.playlistId)
      : state.playlists.selectedIds.filter((id) => !results.some((r) => r.playlistId === id && r.status === 'added'));
    void addToMany(ids, allowDuplicate);
  },

  toggleCreate() {
    state.create.open = !state.create.open;
    render();
  },

  setCreateName(value) {
    state.create.name = value;
    // Re-render só do botão seria ideal; o redesenho completo preserva foco e cursor.
    render();
  },

  setCreatePublic(value) {
    state.create.isPublic = value;
  },

  createAndAdd() {
    const track = currentTrack();
    const name = state.create.name.trim();
    if (!track || !name || state.create.busy) return;
    state.create.busy = true;
    state.add = { status: 'adding', results: state.add.results.filter((r) => r.status === 'added') };
    render();
    void guarded(async () => {
      try {
        const res = await send({ type: 'playlists:create', name, isPublic: state.create.isPublic, trackUri: track.uri });
        state.playlists.items = [res.playlist, ...state.playlists.items.filter((p) => p.id !== res.playlist.id)];
        state.playlists.selectedIds = [...state.playlists.selectedIds, res.playlist.id];
        state.playlists.touched = true;
        state.create = { open: false, name: '', isPublic: false, busy: false };
        const results = state.add.results.filter((r) => r.status === 'added');
        mergeResult(results, { playlistId: res.playlist.id, playlistName: res.playlist.name, status: 'added' });
        state.add = { status: 'done', results };
        await rememberSaved(results);
      } catch (err) {
        state.create.busy = false;
        state.add = { status: 'done', results: [...state.add.results, { playlistId: 'new', playlistName: name, status: 'error', error: asErrorInfo(err) }] };
      }
    }).then(render);
  },

  /** Injeção única na aba ativa (activeTab): vale até a aba navegar. */
  detectHere() {
    const tabId = state.tab.tabId;
    if (tabId === undefined) return;
    void guarded(async () => {
      try {
        // page-hook (mundo principal) primeiro: só vê `play()` chamados depois de instalado.
        await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['page-hook.js'] });
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        state.siteNotice = 'Detector ativado nesta aba. Se a mídia já estava tocando, pause e dê play de novo. Vale até você navegar para outra página.';
      } catch {
        state.siteNotice = 'O Chrome não permitiu ler esta página (páginas internas e a Chrome Web Store são bloqueadas).';
      }
    }).then(render);
  },

  /** Pede a permissão do site ao usuário e registra o detector só para ele. */
  alwaysHere() {
    const { origin, tabId } = state.tab;
    if (!origin) return;
    // permissions.request precisa ser chamado direto do gesto do usuário (sem await antes).
    void chrome.permissions.request({ origins: [`${origin}/*`] }).then(async (granted) => {
      if (!granted) {
        state.siteNotice = 'Permissão negada — nada foi alterado.';
        render();
        return;
      }
      await guarded(async () => {
        try {
          await send({ type: 'sites:enable', origin, tabId });
          state.tab.customEnabled = true;
          state.siteNotice = undefined;
        } catch (err) {
          state.siteNotice = asErrorInfo(err).message;
        }
      });
      render();
    });
  },
};

/* ---------------- inicialização ---------------- */

async function init(): Promise<void> {
  render();
  try {
    state.settings = await getSettings();
    state.lastPlaylistIds = (await getLocal('lastPlaylists')) ?? [];
    await loadTabContext();
  } catch {
    /* sem contexto de aba: o popup ainda funciona com a mídia mais recente */
  }
  await refresh();
  setInterval(() => void refresh(), POLL_MS);
}

void init();
