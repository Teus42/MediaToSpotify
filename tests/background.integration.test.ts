import { beforeEach, describe, expect, it } from 'vitest';
import { PlaylistService } from '../src/background/playlist-service';
import { Router, sanitizeMedia, type Services } from '../src/background/router';
import { SearchService } from '../src/background/search-service';
import { tabsStore } from '../src/background/tabs-store';
import { AuthService } from '../src/spotify/auth';
import { SpotifyClient } from '../src/spotify/client';
import { getMe } from '../src/spotify/playlists';
import { getLocal, getSession, setLocal } from '../src/shared/storage';
import type { MediaInfo } from '../src/shared/types';
import { FakeSpotify, makeAuthDeps, rawTrack } from './helpers/fake-spotify';
import { installFakeChrome } from './helpers/fake-chrome';

interface Harness {
  fake: FakeSpotify;
  router: Router;
  auth: AuthService;
  clock: { now: number };
  timers: Array<() => void>;
  flushTimers(): Promise<void>;
  playlists: PlaylistService;
}

async function harness(options: { connected?: boolean } = {}): Promise<Harness> {
  installFakeChrome();
  const fake = new FakeSpotify();
  const h = makeAuthDeps(fake);
  // O Client ID também vive em chrome.storage.local (como em produção).
  await setLocal('settings', { clientId: fake.clientId });
  const auth = new AuthService({
    ...h.deps,
    loadAuth: () => getLocal('auth'),
    saveAuth: (a) => setLocal('auth', a),
    clearAll: async () => {
      await chrome.storage.local.remove(['auth', 'user', 'playlistsCache']);
    },
    getSettings: async () => ({ clientId: fake.clientId, autoSearch: true, openMode: 'app', market: '' }),
  });
  if (options.connected !== false) await auth.login();

  const sleeps: number[] = [];
  const client = new SpotifyClient({
    fetch: fake.fetch as typeof fetch,
    getAccessToken: () => auth.getAccessToken(),
    refreshAccessToken: () => auth.forceRefresh(),
    sleep: async (ms) => void sleeps.push(ms),
  });
  const clock = h.clock;
  const ensureUser = async () => {
    const stored = await getLocal('user');
    if (stored) return stored;
    const me = await getMe(client);
    await setLocal('user', me);
    return me;
  };
  const search = new SearchService({
    getSettings: async () => ({ clientId: fake.clientId, autoSearch: true, openMode: 'app', market: '' }),
    isConnected: () => auth.isConnected(),
    client,
    now: () => clock.now,
    language: () => 'pt-BR',
  });
  const playlists = new PlaylistService({ client, getUser: ensureUser, now: () => clock.now });
  const timers: Array<() => void> = [];
  const services: Services = {
    auth,
    search,
    playlists,
    ensureUser,
    now: () => clock.now,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => undefined,
  };
  const router = new Router(services);
  return {
    fake,
    router,
    auth,
    clock,
    timers,
    playlists,
    async flushTimers() {
      const pending = timers.splice(0);
      pending.forEach((fn) => fn());
      await new Promise((r) => setTimeout(r, 25));
    },
  };
}

const youtube = (title: string, extra: Partial<MediaInfo> = {}): MediaInfo => ({
  title,
  host: 'www.youtube.com',
  playback: 'playing',
  source: 'site',
  updatedAt: 1,
  durationSec: 355,
  channel: 'Queen Official',
  ...extra,
});

const searchCalls = (fake: FakeSpotify) => fake.calls.filter((c) => c.url.pathname === '/v1/search');

describe('Detecção → pesquisa → resultado (critério de aceitação, sem rede real)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
    h.fake.searchResults = [rawTrack('t1', 'Bohemian Rhapsody', 'Queen', { duration_ms: 355_000 })];
  });

  it('um vídeo musical tocando é identificado, pesquisado e devolvido ao popup', async () => {
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Bohemian Rhapsody (Official Video Remastered)') }, 7, 'www.youtube.com');
    expect(searchCalls(h.fake)).toHaveLength(0); // espera o título "assentar"
    await h.flushTimers();

    const snap = await h.router.snapshot(7);
    expect(snap.media).toMatchObject({ title: expect.stringContaining('Bohemian Rhapsody'), playback: 'playing' });
    expect(snap.search.phase).toBe('done');
    expect(snap.search.outcome?.matches[0]?.track).toMatchObject({ name: 'Bohemian Rhapsody', uri: 'spotify:track:t1' });
    expect(snap.search.manualSearchUrl).toBe('https://open.spotify.com/search/Queen%20Bohemian%20Rhapsody');
    expect(snap.auth.connected).toBe(true);
  });

  it('não repete a busca para a mesma mídia (cache) nem ao reabrir o popup', async () => {
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Bohemian Rhapsody') }, 7, 'www.youtube.com');
    await h.flushTimers();
    await h.router.snapshot(7);
    await h.router.snapshot(7);
    // pausa/retoma a mesma mídia
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Bohemian Rhapsody', { playback: 'paused' }) }, 7, 'www.youtube.com');
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Bohemian Rhapsody') }, 7, 'www.youtube.com');
    await h.flushTimers();
    expect(searchCalls(h.fake)).toHaveLength(1);
  });

  it('pesquisa de novo quando a mídia muda sem recarregar a página', async () => {
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Bohemian Rhapsody') }, 7, 'www.youtube.com');
    await h.flushTimers();
    h.fake.searchResults = [rawTrack('t2', 'Under Pressure', 'Queen')];
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Under Pressure') }, 7, 'www.youtube.com');
    await h.flushTimers();
    const snap = await h.router.snapshot(7);
    expect(searchCalls(h.fake)).toHaveLength(2);
    expect(snap.search.outcome?.matches[0]?.track.name).toBe('Under Pressure');
  });

  it('ignora a pesquisa agendada se a aba já trocou de mídia antes do prazo', async () => {
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Bohemian Rhapsody') }, 7, 'www.youtube.com');
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Under Pressure') }, 7, 'www.youtube.com');
    await h.flushTimers();
    const queries = searchCalls(h.fake).map((c) => c.url.searchParams.get('q') ?? '');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => /Under Pressure/.test(q))).toBe(true);
  });

  it('"não encontrado" vira resultado vazio, não erro', async () => {
    h.fake.searchResults = [];
    await h.router.handleContent({ type: 'media:update', media: youtube('Banda Obscura - Musica Inexistente') }, 7, 'www.youtube.com');
    await h.flushTimers();
    const snap = await h.router.snapshot(7);
    expect(snap.search.phase).toBe('done');
    expect(snap.search.outcome?.status).toBe('not-found');
  });

  it('"Tentar de novo" ignora o cache e refaz a busca', async () => {
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Bohemian Rhapsody') }, 7, 'www.youtube.com');
    await h.flushTimers();
    const before = searchCalls(h.fake).length;
    const snap = await h.router.handle({ type: 'search:retry', tabId: 7 });
    expect(searchCalls(h.fake).length).toBeGreaterThan(before);
    expect(snap.search.phase).toBe('done');
  });
});

describe('Estados sem pesquisa', () => {
  it('sem login: não chama a API e oferece pesquisa manual', async () => {
    const h = await harness({ connected: false });
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Bohemian Rhapsody') }, 7, 'www.youtube.com');
    await h.flushTimers();
    const snap = await h.router.snapshot(7);
    expect(snap.auth).toMatchObject({ configured: true, connected: false });
    expect(snap.search.phase).toBe('idle');
    expect(snap.search.manualSearchUrl).toContain('open.spotify.com/search/');
    expect(h.fake.calls.filter((c) => c.url.hostname === 'api.spotify.com')).toHaveLength(0);
  });

  it('nenhuma mídia: snapshot vazio', async () => {
    const h = await harness();
    expect(await h.router.snapshot(1)).toMatchObject({ tabId: null, media: null, search: { phase: 'idle' } });
  });

  it('mídia pausada em outra aba não conta como "em reprodução"; na aba ativa continua visível', async () => {
    const h = await harness();
    await h.router.handleContent({ type: 'media:update', media: youtube('A - B', { playback: 'paused' }) }, 3, 'www.youtube.com');
    expect((await h.router.snapshot(99)).media).toBeNull();
    expect((await h.router.snapshot(3)).media).toMatchObject({ playback: 'paused' });
  });

  it('escolhe a aba que tocou por último quando várias tocam', async () => {
    const h = await harness();
    await h.router.handleContent({ type: 'media:update', media: youtube('Primeira - Faixa') }, 1, 'www.youtube.com');
    h.clock.now += 5000;
    await h.router.handleContent({ type: 'media:update', media: youtube('Segunda - Faixa') }, 2, 'www.youtube.com');
    expect((await h.router.snapshot(50)).tabId).toBe(2);
  });

  it('media:gone e fechamento de aba removem o estado', async () => {
    const h = await harness();
    await h.router.handleContent({ type: 'media:update', media: youtube('A - B') }, 4, 'www.youtube.com');
    await h.router.handleContent({ type: 'media:gone' }, 4, 'www.youtube.com');
    expect(await tabsStore.get(4)).toBeUndefined();
    await h.router.handleContent({ type: 'media:update', media: youtube('A - B') }, 5, 'www.youtube.com');
    await h.router.forgetTab(5);
    expect(await tabsStore.get(5)).toBeUndefined();
  });
});

describe('Erros e limites', () => {
  const resp = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  it('rate limit: mostra erro com tempo, para de chamar a API e libera após a janela', async () => {
    const h = await harness();
    h.fake.searchResults = [rawTrack('t1', 'Bohemian Rhapsody', 'Queen')];
    h.fake.force('GET /v1/search', resp(429, {}, { 'Retry-After': '60' }));
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Bohemian Rhapsody') }, 7, 'www.youtube.com');
    await h.flushTimers();

    let snap = await h.router.snapshot(7);
    expect(snap.search.phase).toBe('error');
    expect(snap.search.error).toMatchObject({ kind: 'rate-limit', retryAfterSec: 60 });
    const calls = searchCalls(h.fake).length;

    // Mesmo com "Tentar de novo", respeita a janela global.
    snap = await h.router.handle({ type: 'search:retry', tabId: 7 });
    expect(searchCalls(h.fake).length).toBe(calls);
    expect(snap.search.error?.kind).toBe('rate-limit');

    // Janela vencida: volta a funcionar.
    h.clock.now += 61_000;
    snap = await h.router.handle({ type: 'search:retry', tabId: 7 });
    expect(snap.search.phase).toBe('done');
  });

  it('falha de rede vira erro "network" e não é repetida automaticamente em seguida', async () => {
    const h = await harness();
    const boom = () => {
      throw new TypeError('Failed to fetch');
    };
    h.fake.force('GET /v1/search', boom, boom, boom);
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Bohemian Rhapsody') }, 7, 'www.youtube.com');
    await h.flushTimers();
    const snap = await h.router.snapshot(7);
    expect(snap.search).toMatchObject({ phase: 'error', error: { kind: 'network' } });
    const calls = searchCalls(h.fake).length;
    await h.router.snapshot(7);
    expect(searchCalls(h.fake).length).toBe(calls); // cooldown
  });

  it('um estado "pesquisando" órfão (worker suspenso) é retomado depois de 20 s', async () => {
    const h = await harness();
    h.fake.searchResults = [rawTrack('t1', 'Bohemian Rhapsody', 'Queen')];
    await h.router.handleContent({ type: 'media:update', media: youtube('Queen - Bohemian Rhapsody', { playback: 'paused' }) }, 7, 'www.youtube.com');
    const { mediaKey } = await import('../src/shared/media-key');
    const key = mediaKey(youtube('Queen - Bohemian Rhapsody'));
    await chrome.storage.session.set({ searchState: { [key]: { phase: 'searching', at: h.clock.now } } });
    expect((await h.router.snapshot(7)).search.phase).toBe('searching');
    h.clock.now += 25_000;
    await h.router.snapshot(7);
    await new Promise((r) => setTimeout(r, 25));
    expect((await h.router.snapshot(7)).search.phase).toBe('done');
  });
});

describe('sanitizeMedia (entrada não confiável do content script)', () => {
  it('descarta lixo e normaliza campos', () => {
    expect(sanitizeMedia(null, 'a.com', 1)).toBeNull();
    expect(sanitizeMedia({ title: '   ' }, 'a.com', 1)).toBeNull();
    expect(sanitizeMedia({ title: 42 }, 'a.com', 1)).toBeNull();

    const m = sanitizeMedia(
      {
        title: 'x'.repeat(1000),
        host: 'evil.com', // ignorado: o host vem do remetente
        playback: 'hacked',
        source: 'nope',
        artworkUrl: 'javascript:alert(1)',
        durationSec: -5,
        artist: 'Ok',
      },
      'a.com',
      99,
    );
    expect(m).toMatchObject({ host: 'a.com', playback: 'paused', source: 'document', artist: 'Ok', updatedAt: 99 });
    expect(m?.title).toHaveLength(300);
    expect(m?.artworkUrl).toBeUndefined();
    expect(m?.durationSec).toBeUndefined();
    expect(sanitizeMedia({ title: 'T', artworkUrl: 'https://img/x.jpg', durationSec: 200.4 }, 'a.com', 1)).toMatchObject({
      artworkUrl: 'https://img/x.jpg',
      durationSec: 200,
    });
  });
});

describe('PlaylistService', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
    h.fake.playlists = [
      { id: 'mine', name: 'Favoritas', collaborative: false, owner: { id: 'me-id' }, images: [], items: { total: 2 } },
      { id: 'theirs', name: 'Da Maria', collaborative: false, owner: { id: 'maria', display_name: 'Maria' }, images: [], items: { total: 10 } },
      { id: 'collab', name: 'Coletiva', collaborative: true, owner: { id: 'joao' }, images: [], items: { total: 3 } },
    ];
    h.fake.playlistItems.set('mine', ['spotify:track:old1', 'spotify:track:old2']);
  });

  it('lista, usa cache por 5 minutos e atualiza sob demanda sem desconectar', async () => {
    await h.playlists.list();
    await h.playlists.list();
    expect(h.fake.calls.filter((c) => c.url.pathname === '/v1/me/playlists')).toHaveLength(1);
    h.fake.playlists.push({ id: 'nova', name: 'Nova', owner: { id: 'me-id' }, items: { total: 0 } });
    const refreshed = await h.playlists.list(true);
    expect(refreshed.playlists).toHaveLength(4);
    h.clock.now += 6 * 60_000;
    await h.playlists.list();
    expect(h.fake.calls.filter((c) => c.url.pathname === '/v1/me/playlists')).toHaveLength(3);
  });

  it('adiciona a faixa e atualiza a contagem local', async () => {
    await h.playlists.list();
    const res = await h.playlists.add('mine', 'spotify:track:novo');
    expect(res).toEqual({ status: 'added', playlistName: 'Favoritas', duplicateCheck: 'done' });
    expect(h.fake.playlistItems.get('mine')).toContain('spotify:track:novo');
    expect((await getLocal('playlistsCache'))?.playlists.find((p) => p.id === 'mine')?.trackCount).toBe(3);
  });

  it('avisa de faixa repetida e só adiciona de novo com confirmação explícita', async () => {
    await h.playlists.list();
    const dup = await h.playlists.add('mine', 'spotify:track:old1');
    expect(dup.status).toBe('duplicate');
    expect(h.fake.playlistItems.get('mine')).toHaveLength(2);
    const forced = await h.playlists.add('mine', 'spotify:track:old1', true);
    expect(forced.status).toBe('added');
    expect(h.fake.playlistItems.get('mine')).toHaveLength(3);
  });

  it('bloqueia playlists somente leitura sem chamar a API; aceita colaborativas', async () => {
    await h.playlists.list();
    const before = h.fake.calls.length;
    await expect(h.playlists.add('theirs', 'spotify:track:x')).rejects.toMatchObject({ kind: 'forbidden' });
    expect(h.fake.calls.length).toBe(before);
    await expect(h.playlists.add('collab', 'spotify:track:x')).resolves.toMatchObject({ status: 'added' });
  });

  it('cria playlist nova já com a faixa dentro e a coloca no topo da lista', async () => {
    await h.playlists.list();
    const res = await h.playlists.create('Descobertas', false, 'spotify:track:abc');
    expect(res).toMatchObject({ added: true, playlist: { name: 'Descobertas', editable: true, trackCount: 1 } });
    expect(h.fake.playlistItems.get(res.playlist.id)).toEqual(['spotify:track:abc']);
    expect((await getLocal('playlistsCache'))?.playlists[0]?.name).toBe('Descobertas');
  });

  it('logout apaga tokens, perfil e cache de playlists', async () => {
    await h.playlists.list();
    await h.router.handle({ type: 'auth:logout' });
    expect(await getLocal('auth')).toBeUndefined();
    expect(await getLocal('user')).toBeUndefined();
    expect(await getLocal('playlistsCache')).toBeUndefined();
    expect(await getSession('tabs')).toBeUndefined();
  });
});
