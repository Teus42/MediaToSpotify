// Servidor local (só para o E2E) que simula accounts.spotify.com + api.spotify.com (reusa o FakeSpotify dos testes)
// e serve uma página de teste com <audio> + Media Session.
import http from 'node:http';
import { FakeSpotify, rawTrack } from '../tests/helpers/fake-spotify';

const PORT = 8777;
const fake = new FakeSpotify();
fake.clientId = 'e2eclientid1234567890abcdef12';

fake.searchByQuery.set('track:"Bohemian Rhapsody" artist:"Queen"', [
  rawTrack('t1', 'Bohemian Rhapsody', 'Queen', { duration_ms: 90_000, album: { name: 'A Night at the Opera', album_type: 'album', images: [] } }),
  rawTrack('t1b', 'Bohemian Rhapsody - Live Aid', 'Queen', { duration_ms: 130_000 }),
]);
fake.searchByQuery.set('track:"Under Pressure" artist:"Queen"', [rawTrack('t2', 'Under Pressure', 'Queen', { duration_ms: 90_000 })]);
fake.playlists = [
  { id: 'mine', name: 'Favoritas', collaborative: false, owner: { id: 'me-id' }, images: [], items: { total: 2 } },
  { id: 'theirs', name: 'Da Maria', collaborative: false, owner: { id: 'maria', display_name: 'Maria' }, images: [], items: { total: 10 } },
  { id: 'collab', name: 'Coletiva', collaborative: true, owner: { id: 'joao' }, images: [], items: { total: 3 } },
];
fake.playlistItems.set('mine', ['spotify:track:old1', 'spotify:track:old2']);

function wav(seconds: number): Buffer {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return buf;
}
const TONE = wav(90);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Página de teste</title></head><body>
<h1>Player de teste</h1>
<audio id="a" src="/tone.wav" controls></audio>
<script>
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera' });
  window.setTrack = (t, a) => { navigator.mediaSession.metadata = new MediaMetadata({ title: t, artist: a }); };
  document.getElementById('a').play().catch(e => document.title = 'autoplay bloqueado: ' + e.message);
</script></body></html>`;

// Player que cria o <audio> SEM inseri-lo na página (como fazem SoundCloud e outros): os eventos de mídia
// de elementos fora do DOM não chegam ao `document`.
const DETACHED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Detached test</title></head><body>
<h1>Player com áudio fora do DOM</h1><div id="badge">Faixa Solta — Artista Solto</div>
<script>
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Faixa Solta', artist: 'Artista Solto' });
  const a = new Audio('/tone.wav');
  window.__a = a;
  a.play().catch(e => document.title = 'autoplay bloqueado: ' + e.message);
</script></body></html>`;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();

    if (url.pathname === '/page') return void res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    if (url.pathname === '/detached') return void res.writeHead(200, { 'Content-Type': 'text/html' }).end(DETACHED_PAGE);
    if (url.pathname === '/tone.wav') {
      return void res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': TONE.length, 'Accept-Ranges': 'none' }).end(TONE);
    }
    if (url.pathname === '/__state') {
      return void res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ calls: fake.calls.map((c) => ({ method: c.method, path: c.url.pathname, q: c.url.search })), playlistItems: Object.fromEntries(fake.playlistItems), playlists: fake.playlists.map((p) => p.name) }));
    }
    if (url.pathname === '/authorize') {
      const loc = await fake.authorize({ url: 'https://accounts.spotify.com/authorize' + url.search, interactive: true });
      return void res.writeHead(302, { Location: loc }).end();
    }

    const isToken = url.pathname === '/api/token';
    if (isToken || url.pathname.startsWith('/v1/')) {
      const body = await readBody(req);
      const headers: Record<string, string> = {};
      if (req.headers.authorization) headers.Authorization = String(req.headers.authorization);
      if (req.headers['content-type']) headers['Content-Type'] = String(req.headers['content-type']);
      const r = await fake.fetch(`https://${isToken ? 'accounts' : 'api'}.spotify.com${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: body || undefined,
      });
      return void res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(await r.text());
    }
    res.writeHead(404).end('not found');
  })
  .listen(PORT, '127.0.0.1', () => console.log('mock ready on', PORT));
