import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from './chrome.mjs';

// Sonda MANUAL (depende da rede e do HTML atual do YouTube): npm run e2e:youtube
const EXT = join(import.meta.dirname, '.out', 'dist-test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true, pipe: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'm2s-yt-')), enableExtensions: [EXT],
  args: ['--autoplay-policy=no-user-gesture-required', '--no-first-run', '--mute-audio', '--lang=pt-BR'],
});
const swT = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
const sw = await swT.worker();
async function probe(url, label, wait = 20000) {
  const page = await browser.newPage();
  await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
  await page.setViewport({ width: 1280, height: 800 });
  console.log(`\n== ${label}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => console.log('goto:', e.message));
  await sleep(3000);
  // aceita consentimento se aparecer
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /aceitar tudo|accept all|concordo/i.test(x.textContent)); b?.click(); }).catch(() => {});
  const t0 = Date.now();
  let entry = null;
  while (Date.now() - t0 < wait) {
    const tabs = await sw.evaluate(async () => (await chrome.storage.session.get('tabs')).tabs).catch(() => null);
    entry = tabs ? Object.values(tabs).find((e) => /youtube/.test(e.media.host)) : null;
    if (entry?.media.playback === 'playing') break;
    await sleep(1000);
    // tenta dar play se bloqueado
    await page.evaluate(() => { const v = document.querySelector('video'); if (v && v.paused) v.play().catch(() => {}); }).catch(() => {});
  }
  console.log('media:', JSON.stringify(entry?.media));
  const diag = await page.evaluate(() => ({
    title: document.title,
    path: location.pathname + location.search,
    video: !!document.querySelector('video'),
    paused: document.querySelector('video')?.paused,
    h1: document.querySelector('ytd-watch-metadata h1 yt-formatted-string')?.textContent?.trim(),
    channel: document.querySelector('ytd-watch-metadata ytd-channel-name#channel-name a')?.textContent?.trim(),
    ad: !!document.querySelector('.html5-video-player.ad-showing'),
    ytmTitle: document.querySelector('ytmusic-player-bar yt-formatted-string.title')?.textContent?.trim(),
    ytmByline: document.querySelector('ytmusic-player-bar yt-formatted-string.byline')?.textContent?.trim(),
    ms: navigator.mediaSession.metadata ? { t: navigator.mediaSession.metadata.title, a: navigator.mediaSession.metadata.artist } : null,
  })).catch((e) => ({ err: e.message }));
  console.log('diag:', JSON.stringify(diag));
  await page.screenshot({ path: join(import.meta.dirname, '.out', `yt-${label}.png`) });
  await page.close();
}
await probe('https://www.youtube.com/watch?v=fJ9rUzIMcZQ', 'youtube-queen');
await probe('https://www.youtube.com/watch?v=09839DpTctU', 'youtube-eagles');
await probe('https://music.youtube.com/watch?v=fJ9rUzIMcZQ', 'ytmusic');
await browser.close();
