import puppeteer from 'puppeteer-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findChrome } from './chrome.mjs';

const CHROME = findChrome();
const EXT = join(import.meta.dirname, '.out', 'dist-test');
const SHOTS = join(import.meta.dirname, '.out', 'shots');
mkdirSync(SHOTS, { recursive: true });
const CLIENT_ID = 'e2eclientid1234567890abcdef12';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
async function until(fn, ms = 15000, step = 250) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}
async function typeText(page, selector, text) {
  await page.focus(selector);
  for (const ch of text) { await page.keyboard.sendCharacter(ch); await sleep(60); }
}
const state = async () => (await fetch('http://127.0.0.1:8777/__state')).json();

const userDataDir = mkdtempSync(join(tmpdir(), 'm2s-e2e-'));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  pipe: true,
  userDataDir,
  enableExtensions: [EXT],
  args: ['--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--window-size=1000,800'],
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  check('Extensão carregada e service worker ativo', !!extId, `id=${extId}`);

  // Configura o Client ID do app (como o usuário faria nas opções).
  await until(async () => { await sw.evaluate((id) => chrome.storage.local.set({ settings: { clientId: id } }), CLIENT_ID); return true; }, 10000);

  /* ---------- Etapa 1: detecção de mídia (Media Session, content script real) ---------- */
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8777/page', { waitUntil: 'load' });
  const tabsState = await until(async () => {
    const t = await sw.evaluate(async () => (await chrome.storage.session.get('tabs')).tabs);
    return t && Object.keys(t).length ? t : null;
  });
  const entry = tabsState ? Object.values(tabsState)[0] : null;
  console.log('   mídia detectada:', JSON.stringify(entry?.media));
  check('Detecta <audio> tocando e lê a Media Session (título, artista, álbum)', entry?.media?.title === 'Bohemian Rhapsody' && entry?.media?.artist === 'Queen' && entry?.media?.album === 'A Night at the Opera' && entry?.media?.playback === 'playing', `source=${entry?.media?.source}`);
  check('Duração capturada', entry?.media?.durationSec === 90);

  // Player com <audio> fora do DOM (new Audio()): também precisa ser detectado.
  const detached = await browser.newPage();
  await detached.goto('http://127.0.0.1:8777/detached', { waitUntil: 'load' });
  const detEntry = await until(async () => {
    const t = await sw.evaluate(async () => (await chrome.storage.session.get('tabs')).tabs);
    return Object.values(t ?? {}).find((e) => e.media.title === 'Faixa Solta') ?? null;
  }, 10000);
  check('Detecta mídia tocando em <audio> criado fora do DOM (new Audio())', !!detEntry && detEntry.media.playback === 'playing', JSON.stringify(detEntry?.media));
  await detached.close();
  await sleep(500);

  // Sem login ainda: nenhuma chamada à API.
  await sleep(2500);
  let st = await state();
  check('Sem login, nenhuma chamada à API do Spotify', st.calls.filter((c) => c.path.startsWith('/v1')).length === 0);

  /* ---------- Popup sem login ---------- */
  const popup = await browser.newPage();
  await popup.setViewport({ width: 380, height: 560, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await until(async () => (await popup.$('.media-title')) !== null);
  await sleep(300);
  await popup.screenshot({ path: join(SHOTS, '1-sem-login.png') });
  const txt = await popup.evaluate(() => document.body.innerText);
  check('Popup mostra a mídia atual e pede conexão', /Bohemian Rhapsody/.test(txt) && /Conectar ao Spotify/.test(txt));

  /* ---------- Etapa 3: OAuth real (launchWebAuthFlow) ---------- */
  const redirect = await sw.evaluate(() => chrome.identity.getRedirectURL());
  console.log('   redirect URI:', redirect);
  // Dispara o login pela página de opções (contexto de extensão real), como o usuário faria.
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  await until(async () => !(await options.$eval('#connect', (b) => b.disabled)));
  await options.screenshot({ path: join(SHOTS, '2-opcoes.png'), fullPage: true });
  const redirectShown = await options.$eval('#redirect', (i) => i.value);
  check('Página de opções mostra o Redirect URI correto', redirectShown === redirect);
  await options.click('#connect');
  const connected = await until(async () => {
    const s = await options.$eval('#authStatus', (e) => e.textContent);
    return /Conectado/.test(s) ? s : null;
  }, 20000);
  console.log('   status:', connected);
  check('OAuth Authorization Code + PKCE concluído (launchWebAuthFlow)', !!connected);
  st = await state();
  check('Troca de código no /api/token verificou o PKCE', st.calls.some((c) => c.path === '/api/token'));
  const stored = await sw.evaluate(async () => (await chrome.storage.local.get('auth')).auth);
  check('Tokens guardados no storage.local (com refresh token)', !!stored?.accessToken && !!stored?.refreshToken);

  /* ---------- Etapa 2: pesquisa automática ---------- */
  await popup.bringToFront();
  await popup.reload();
  const found = await until(async () => (await popup.$('.track-name')) !== null, 15000);
  await sleep(400);
  await popup.screenshot({ path: join(SHOTS, '3-resultado.png') });
  const resTxt = await popup.evaluate(() => document.body.innerText);
  console.log('   popup:', resTxt.replace(/\n+/g, ' | ').slice(0, 300));
  check('Pesquisa automática encontra a faixa e o popup exibe o resultado', !!found && /Bohemian Rhapsody/.test(resTxt) && /Queen/.test(resTxt) && /Correspondência provável/.test(resTxt));
  st = await state();
  const searches = st.calls.filter((c) => c.path === '/v1/search');
  check('Exatamente 1 requisição de busca (cache/deduplicação)', searches.length === 1, `chamadas=${searches.length}`);
  check('Busca usa limit=10 e type=track', /limit=10/.test(searches[0]?.q ?? '') && /type=track/.test(searches[0]?.q ?? ''));

  // Reabrir o popup não repete a busca.
  await popup.reload();
  await until(async () => (await popup.$('.track-name')) !== null);
  await sleep(1800);
  st = await state();
  check('Reabrir o popup não dispara nova busca', st.calls.filter((c) => c.path === '/v1/search').length === 1);

  /* ---------- Troca de faixa sem recarregar a página ---------- */
  await page.evaluate(() => window.setTrack('Under Pressure', 'Queen'));
  await until(async () => (await state()).calls.filter((c) => c.path === '/v1/search').length >= 2, 15000);
  await popup.reload();
  await until(async () => /Under Pressure/.test(await popup.evaluate(() => document.body.innerText)), 10000);
  await sleep(300);
  check('Troca de faixa na mesma página é detectada e pesquisada', /Under Pressure/.test(await popup.evaluate(() => document.querySelector('.track-name')?.textContent ?? '')));
  await page.evaluate(() => window.setTrack('Bohemian Rhapsody', 'Queen'));
  await sleep(4000);

  /* ---------- Etapa 4: Ouvir no Spotify ---------- */
  await popup.reload();
  await until(async () => /Bohemian Rhapsody/.test(await popup.evaluate(() => document.querySelector('.track-name')?.textContent ?? '')), 10000);
  // Abrir no Spotify Web → nova aba para open.spotify.com/track/t1
  const newTabP = new Promise((resolve) => browser.once('targetcreated', resolve));
  await popup.evaluate(() => [...document.querySelectorAll('button.link')].find((b) => /Spotify Web/.test(b.textContent)).click());
  const newTarget = await Promise.race([newTabP, sleep(5000).then(() => null)]);
  check('"Abrir no Spotify Web" abre open.spotify.com/track/<id> em nova aba', !!newTarget && /open\.spotify\.com\/track\/t1/.test(newTarget.url()), newTarget?.url());
  try { await (await newTarget.page())?.close(); } catch {}

  // Ouvir no Spotify (app): tenta o protocolo spotify: e mostra o aviso de que não dá para confirmar.
  await popup.bringToFront();
  await popup.evaluate(() => [...document.querySelectorAll('button.btn.primary')].find((b) => /Ouvir/.test(b.textContent)).click());
  await sleep(500);
  const hint = await popup.evaluate(() => document.body.innerText);
  check('"Ouvir no Spotify" avisa que não confirma a abertura do app e oferece o Web', /Não conseguimos confirmar/.test(hint));
  await popup.screenshot({ path: join(SHOTS, '4-ouvir.png') });

  /* ---------- Etapa 5: playlists ---------- */
  await popup.bringToFront();
  await popup.evaluate(() => [...document.querySelectorAll('button.btn')].find((b) => /Adicionar à playlist/.test(b.textContent)).click());
  await until(async () => (await popup.$$('.pl-row')).length > 0, 10000);
  await sleep(300);
  await popup.screenshot({ path: join(SHOTS, '5-playlists.png') });
  const rows = await popup.$$eval('.pl-row', (els) => els.map((e) => ({ name: e.querySelector('.pl-name').textContent, disabled: e.classList.contains('disabled'), meta: e.querySelector('.pl-meta').textContent })));
  console.log('   playlists:', JSON.stringify(rows));
  check('Lista playlists com contagem e marca a somente-leitura como desabilitada', rows.length === 3 && rows.find((r) => r.name === 'Da Maria')?.disabled === true && /2 faixas/.test(rows[0].meta));

  // Filtro
  await typeText(popup, '[data-key="pl-filter"]', 'fav');
  await sleep(200);
  const dbgF = await popup.evaluate(() => ({ rows: document.querySelectorAll('.pl-row').length, active: document.activeElement?.getAttribute('data-key'), value: document.querySelector('[data-key="pl-filter"]')?.value }));
  check('Campo de busca filtra playlists (sem perder o foco)', dbgF.rows === 1 && dbgF.active === 'pl-filter', JSON.stringify(dbgF));
  await popup.$eval('[data-key="pl-filter"]', (i) => { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(200);

  // Seleciona e confirma (nada vem pré-selecionado na primeira vez)
  check('Na primeira vez nenhuma playlist vem pré-selecionada', (await popup.$$eval('.pl-row input:checked', (e) => e.length)) === 0);
  await popup.evaluate(() => [...document.querySelectorAll('.pl-row')].find((r) => /Favoritas/.test(r.textContent)).querySelector('input').click());
  await sleep(200);
  await popup.evaluate(() => [...document.querySelectorAll('button.btn.primary')].find((b) => /Adicionar a “Favoritas”/.test(b.textContent)).click());
  await until(async () => /Faixa adicionada/.test(await popup.evaluate(() => document.body.innerText)), 8000);
  await popup.screenshot({ path: join(SHOTS, '6-adicionada.png') });
  st = await state();
  check('Faixa realmente adicionada na playlist via POST /playlists/{id}/items', st.playlistItems.mine?.includes('spotify:track:t1'), JSON.stringify(st.playlistItems.mine));
  check('Popup confirma "Faixa adicionada!"', /Faixa adicionada/.test(await popup.evaluate(() => document.body.innerText)));
  const last1 = await sw.evaluate(async () => (await chrome.storage.local.get('lastPlaylists')).lastPlaylists);
  check('A última playlist usada é guardada', JSON.stringify(last1) === JSON.stringify(['mine']), JSON.stringify(last1));

  // Reabrir o popup: a última playlist já vem marcada
  await popup.reload();
  await until(async () => (await popup.$('.track-name')) !== null);
  await popup.evaluate(() => [...document.querySelectorAll('button.btn')].find((b) => /Adicionar à playlist/.test(b.textContent)).click());
  await until(async () => (await popup.$$('.pl-row')).length > 0);
  await sleep(200);
  const pre = await popup.$$eval('.pl-row', (els) => els.map((e) => ({ n: e.querySelector('.pl-name').textContent, c: e.querySelector('input').checked })));
  check('Na vez seguinte a última playlist vem pré-selecionada', pre.find((r) => r.n === 'Favoritas')?.c === true && pre.filter((r) => r.c).length === 1, JSON.stringify(pre));

  // Várias playlists de uma vez: Favoritas (já tem a faixa) + Coletiva
  await popup.evaluate(() => [...document.querySelectorAll('.pl-row')].find((r) => /Coletiva/.test(r.textContent)).querySelector('input').click());
  await sleep(200);
  check('O botão resume a seleção múltipla', /Adicionar a 2 playlists/.test(await popup.evaluate(() => document.body.innerText)));
  await popup.evaluate(() => [...document.querySelectorAll('button.btn.primary')].find((b) => /Adicionar a 2 playlists/.test(b.textContent)).click());
  await until(async () => /já está na playlist/i.test(await popup.evaluate(() => document.body.innerText)), 8000);
  await popup.screenshot({ path: join(SHOTS, '7-duplicada.png') });
  st = await state();
  const txt2 = await popup.evaluate(() => document.body.innerText);
  check('Duplicata em uma playlist não impede salvar nas outras', /“Favoritas” já contém/.test(txt2) && /Salva em “Coletiva”/.test(txt2) && st.playlistItems.collab?.includes('spotify:track:t1') && st.playlistItems.mine.filter((u) => u === 'spotify:track:t1').length === 1, JSON.stringify(st.playlistItems));


  // Criar nova playlist
  await popup.evaluate(() => [...document.querySelectorAll('button.link')].find((b) => /Nova playlist/.test(b.textContent)).click());
  await sleep(200);
  await typeText(popup, '[data-key="create-name"]', 'Descobertas E2E');
  await popup.evaluate(() => [...document.querySelectorAll('button.btn')].find((b) => /Criar e adicionar/.test(b.textContent)).click());
  await until(async () => /Salva em .*Descobertas E2E/.test(await popup.evaluate(() => document.body.innerText)), 8000);
  st = await state();
  check('Cria playlist nova e adiciona a faixa', st.playlists.includes('Descobertas E2E') && Object.values(st.playlistItems).filter((l) => l.length === 1 && l[0] === 'spotify:track:t1').length === 2);
  await popup.screenshot({ path: join(SHOTS, '8-nova-playlist.png') });

  /* ---------- Desconectar ---------- */
  await options.bringToFront();
  await options.click('#disconnect');
  await sleep(800);
  const after = await sw.evaluate(async () => await chrome.storage.local.get(['auth', 'user', 'playlistsCache', 'lastPlaylists']));
  check('Desconectar apaga tokens, perfil, cache e a última playlist', !after.auth && !after.user && !after.playlistsCache && !after.lastPlaylists);

  // Content script não acessa o storage da extensão
  const leak = await page.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage);
  check('Página web não enxerga chrome.storage da extensão', leak === false);
} catch (err) {
  console.log('ERRO no E2E:', err);
  results.push({ name: 'execução sem exceção', ok: false });
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}
