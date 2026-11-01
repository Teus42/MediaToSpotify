import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/spotify/auth';
import { SpotifyClient } from '../src/spotify/client';
import { addTrackToPlaylist, createPlaylist, getMe, listPlaylists, mapPlaylist, playlistContainsTrack } from '../src/spotify/playlists';
import { mapTrack, pickImage, resolveMarket, searchTrack } from '../src/spotify/search';
import { parseMediaTitle } from '../src/metadata/title-parser';
import { AppError } from '../src/shared/errors';
import { FakeSpotify, makeAuthDeps, rawTrack } from './helpers/fake-spotify';

async function setup() {
  const fake = new FakeSpotify();
  const h = makeAuthDeps(fake);
  const auth = new AuthService(h.deps);
  await auth.login();
  const sleeps: number[] = [];
  const client = new SpotifyClient({
    fetch: fake.fetch as typeof fetch,
    getAccessToken: () => auth.getAccessToken(),
    refreshAccessToken: () => auth.forceRefresh(),
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { fake, h, auth, client, sleeps };
}

const resp = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('SpotifyClient — políticas de erro', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it('401: renova o token uma vez e repete a requisição', async () => {
    s.fake.validAccessToken = 'revogado-no-servidor'; // token local ainda "válido", mas o servidor o recusa
    const me = await getMe(s.client);
    expect(me).toEqual({ id: 'me-id', displayName: 'Usuário Teste' });
    const api = s.fake.calls.filter((c) => c.url.hostname === 'api.spotify.com');
    expect(api).toHaveLength(2);
    expect(api[0]?.headers.Authorization).not.toBe(api[1]?.headers.Authorization);
  });

  it('401 persistente depois da renovação vira unauthenticated (sem laço infinito)', async () => {
    s.fake.force('GET /v1/me', resp(401, { error: { message: 'x' } }), resp(401, { error: { message: 'x' } }));
    const err = await getMe(s.client).catch((e) => e);
    expect((err as AppError).kind).toBe('unauthenticated');
    expect(s.fake.calls.filter((c) => c.url.pathname === '/v1/me')).toHaveLength(2);
  });

  it('429 com Retry-After curto: espera e tenta de novo', async () => {
    s.fake.force('GET /v1/me', resp(429, {}, { 'Retry-After': '2' }));
    await expect(getMe(s.client)).resolves.toMatchObject({ id: 'me-id' });
    expect(s.sleeps).toEqual([2100]);
  });

  it('429 com Retry-After longo: não bloqueia, devolve rate-limit com o tempo', async () => {
    s.fake.force('GET /v1/me', resp(429, {}, { 'Retry-After': '30' }));
    const err = (await getMe(s.client).catch((e) => e)) as AppError;
    expect(err.kind).toBe('rate-limit');
    expect(err.retryAfterSec).toBe(30);
    expect(s.sleeps).toEqual([]);
  });

  it('GET: tenta de novo em 5xx e em falha de rede', async () => {
    s.fake.force('GET /v1/me', resp(503), () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(getMe(s.client)).resolves.toMatchObject({ id: 'me-id' });
    expect(s.sleeps).toEqual([400, 1200]);
  });

  it('GET: desiste após 2 novas tentativas com erro de rede', async () => {
    const boom = () => {
      throw new TypeError('Failed to fetch');
    };
    s.fake.force('GET /v1/me', boom, boom, boom);
    const err = (await getMe(s.client).catch((e) => e)) as AppError;
    expect(err.kind).toBe('network');
  });

  it('POST nunca é repetido automaticamente (evita duplicar faixa na playlist)', async () => {
    s.fake.force('POST /v1/playlists/p1/items', resp(503));
    const err = (await addTrackToPlaylist(s.client, 'p1', 'spotify:track:abc').catch((e) => e)) as AppError;
    expect(err.kind).toBe('api');
    expect(s.fake.calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/items'))).toHaveLength(1);
  });

  it('403 vira "forbidden" com orientação; 404 vira "not-found"', async () => {
    s.fake.force('POST /v1/playlists/p1/items', resp(403, { error: { status: 403, message: 'Insufficient client scope' } }));
    const forbidden = (await addTrackToPlaylist(s.client, 'p1', 'spotify:track:abc').catch((e) => e)) as AppError;
    expect(forbidden.kind).toBe('forbidden');
    expect(forbidden.message).toContain('Insufficient client scope');

    s.fake.force('POST /v1/playlists/p2/items', resp(404, { error: { status: 404, message: 'Not found' } }));
    const missing = (await addTrackToPlaylist(s.client, 'p2', 'spotify:track:abc').catch((e) => e)) as AppError;
    expect(missing.kind).toBe('not-found');
  });
});

describe('Busca', () => {
  it('envia type=track, limit=10 (máximo atual) e market; 1 requisição quando o 1º resultado é confiável', async () => {
    const { fake, client } = await setup();
    fake.searchResults = [rawTrack('t1', 'Bohemian Rhapsody', 'Queen', { duration_ms: 355_000 })];
    const outcome = await searchTrack(client, parseMediaTitle({ title: 'Queen - Bohemian Rhapsody (Official Video)' }), {
      market: 'BR',
      durationSec: 355,
      now: () => 42,
    });
    const searches = fake.calls.filter((c) => c.url.pathname === '/v1/search');
    expect(searches).toHaveLength(1);
    expect(searches[0]?.url.searchParams.get('limit')).toBe('10');
    expect(searches[0]?.url.searchParams.get('type')).toBe('track');
    expect(searches[0]?.url.searchParams.get('market')).toBe('BR');
    expect(searches[0]?.url.searchParams.get('q')).toBe('track:"Bohemian Rhapsody" artist:"Queen"');
    expect(outcome).toMatchObject({ status: 'found', searchedAt: 42 });
    expect(outcome.matches[0]).toMatchObject({ confidence: 'high' });
    expect(outcome.matches[0]?.track).toMatchObject({
      uri: 'spotify:track:t1',
      url: 'https://open.spotify.com/track/t1',
      albumArtUrl: 'https://img/t1-640.jpg',
    });
  });

  it('amplia a consulta quando a primeira não encontra e informa "not-found" se nada servir', async () => {
    const { fake, client } = await setup();
    fake.searchResults = [rawTrack('x', 'Outra Coisa Totalmente', 'Alguém'), null];
    const outcome = await searchTrack(client, parseMediaTitle({ title: 'Banda Obscura - Musica Inexistente' }));
    expect(fake.calls.filter((c) => c.url.pathname === '/v1/search').length).toBeGreaterThan(1);
    expect(outcome.status).toBe('not-found');
    expect(outcome.matches).toEqual([]);
    // Diagnóstico para "Detalhes técnicos": consultas, contagem de resultados e candidatas com nota.
    expect(outcome.debug?.queries.every((q) => q.returned === 1)).toBe(true);
    expect(outcome.debug?.top[0]).toMatchObject({ name: 'Outra Coisa Totalmente', artists: ['Alguém'] });
    expect(outcome.debug?.readings[0]).toMatchObject({ artist: 'Banda Obscura' });
  });

  it('quando só há palpites fracos, devolve "found" com confiança weak e inclui o diagnóstico', async () => {
    const { fake, client } = await setup();
    // O Spotify catalogou pelo nome romanizado; o título do vídeo traz os dois nomes.
    fake.searchResults = [
      rawTrack('a', '好きでいてくれていいよ', 'すとぷり', { duration_ms: 225_000 }),
      rawTrack('b', 'Suki de Ite', 'Ado', { duration_ms: 245_000 }),
    ];
    const outcome = await searchTrack(client, parseMediaTitle({ title: '【Ado】好きでいて (Suki de Ite)', channel: 'Ado' }), { durationSec: 245 });
    expect(outcome.status).toBe('found');
    expect(outcome.matches[0]?.track.name).toBe('Suki de Ite');
    expect(outcome.matches[0]?.confidence).toBe('high');

    // Sem o apelido no título, só sobra o artista + duração: palpite "weak", nunca "high".
    const weak = await searchTrack(client, parseMediaTitle({ title: '【Ado】好きでいて', channel: 'Ado' }), { durationSec: 245 });
    expect(weak.status).toBe('found');
    expect(weak.matches[0]?.track.name).toBe('Suki de Ite');
    expect(weak.matches[0]?.confidence).toBe('weak');
    expect(weak.debug?.top[0]).toMatchObject({ name: 'Suki de Ite' });
  });

  it('ignora itens nulos/inválidos devolvidos pela API', () => {
    expect(mapTrack(null)).toBeNull();
    expect(mapTrack({ id: 'a' })).toBeNull();
    expect(mapTrack({ id: 'a', name: 'N', artists: [null, { name: 'A' }], duration_ms: 1000 })).toMatchObject({ artists: ['A'], uri: 'spotify:track:a' });
  });

  it('escolhe uma capa de tamanho razoável', () => {
    expect(pickImage([{ url: 'g', width: 640 }, { url: 'm', width: 300 }, { url: 's', width: 64 }])).toBe('m');
    expect(pickImage([{ url: 's', width: 64 }])).toBe('s');
    expect(pickImage([])).toBeUndefined();
  });

  it('resolve o mercado pela configuração ou pelo idioma, ignorando valores inválidos', () => {
    expect(resolveMarket('us', 'pt-BR')).toBe('US');
    expect(resolveMarket('', 'pt-BR')).toBe('BR');
    expect(resolveMarket('xyz', 'en-GB')).toBe('GB');
    expect(resolveMarket('', 'en')).toBeUndefined();
    expect(resolveMarket(undefined, undefined)).toBeUndefined();
  });
});

describe('Playlists', () => {
  it('carrega todas as páginas e marca quais aceitam edição', async () => {
    const { fake, client } = await setup();
    fake.playlists = Array.from({ length: 120 }, (_, i) => ({
      id: `p${i}`,
      name: `Playlist ${i}`,
      collaborative: i === 1,
      owner: { id: i === 0 ? 'me-id' : 'outro', display_name: 'Outro' },
      images: [{ url: `https://img/p${i}.jpg`, width: 300 }],
      items: { total: i },
    }));
    const me = await getMe(client);
    const lists = await listPlaylists(client, me.id);
    expect(lists).toHaveLength(120);
    expect(fake.calls.filter((c) => c.url.pathname === '/v1/me/playlists')).toHaveLength(3);
    expect(lists[0]).toMatchObject({ editable: true, trackCount: 0, imageUrl: 'https://img/p0.jpg' });
    expect(lists[1]).toMatchObject({ editable: true, collaborative: true }); // colaborativa de outro dono
    expect(lists[2]).toMatchObject({ editable: false, ownerName: 'Outro' }); // só leitura
  });

  it('lê a contagem tanto de `items.total` quanto do antigo `tracks.total`; ignora entradas inválidas', () => {
    expect(mapPlaylist({ id: 'a', name: 'A', tracks: { total: 7 }, owner: { id: 'u' } }, 'u')).toMatchObject({ trackCount: 7 });
    expect(mapPlaylist({ id: 'a', name: 'A', items: { total: 3 }, owner: { id: 'u' } }, 'u')).toMatchObject({ trackCount: 3 });
    expect(mapPlaylist({ name: 'sem id' }, 'u')).toBeNull();
    expect(mapPlaylist(null, 'u')).toBeNull();
  });

  it('adiciona a faixa com POST /playlists/{id}/items e corpo { uris }', async () => {
    const { fake, client } = await setup();
    await addTrackToPlaylist(client, 'pl 1', 'spotify:track:abc123');
    const call = fake.calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/items'));
    expect(call?.url.pathname).toBe('/v1/playlists/pl%201/items');
    expect(call?.body).toEqual({ uris: ['spotify:track:abc123'] });
    expect(fake.playlistItems.get('pl 1')).toEqual(['spotify:track:abc123']);
  });

  it('rejeita URI que não é de faixa antes de chamar a API', async () => {
    const { fake, client } = await setup();
    const before = fake.calls.length;
    await expect(addTrackToPlaylist(client, 'p', 'spotify:episode:xyz')).rejects.toMatchObject({ kind: 'bad-request' });
    expect(fake.calls.length).toBe(before);
  });

  it('detecta faixa repetida varrendo várias páginas', async () => {
    const { fake, client } = await setup();
    fake.playlistItems.set('big', [...Array.from({ length: 70 }, (_, i) => `spotify:track:n${i}`), 'spotify:track:alvo']);
    expect(await playlistContainsTrack(client, 'big', 'spotify:track:alvo', 71)).toBe('yes');
    expect(await playlistContainsTrack(client, 'big', 'spotify:track:ausente', 71)).toBe('no');
  });

  it('devolve "unknown" quando não dá para verificar (playlist enorme ou leitura negada)', async () => {
    const { fake, client } = await setup();
    const before = fake.calls.length;
    expect(await playlistContainsTrack(client, 'enorme', 'spotify:track:a', 5000)).toBe('unknown');
    expect(fake.calls.length).toBe(before); // nem chegou a consultar

    fake.force('GET /v1/playlists/privada/items', resp(403, { error: { status: 403, message: 'Forbidden' } }));
    expect(await playlistContainsTrack(client, 'privada', 'spotify:track:a')).toBe('unknown');
  });

  it('cria playlist com POST /me/playlists (privada por padrão no app) e devolve editável', async () => {
    const { fake, client } = await setup();
    const created = await createPlaylist(client, 'me-id', '  Descobertas  ', false);
    const call = fake.calls.find((c) => c.method === 'POST' && c.url.pathname === '/v1/me/playlists');
    expect(call?.body).toMatchObject({ name: 'Descobertas', public: false });
    expect(created).toMatchObject({ name: 'Descobertas', editable: true });
    await expect(createPlaylist(client, 'me-id', '   ', false)).rejects.toMatchObject({ kind: 'bad-request' });
  });
});
