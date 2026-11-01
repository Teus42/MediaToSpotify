// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaDetector } from '../src/content/detector';
import type { MediaInfo } from '../src/shared/types';

function fakeMedia(tag: 'video' | 'audio' = 'video'): HTMLMediaElement {
  const el = document.createElement(tag);
  const state = { paused: true, ended: false, readyState: 4, duration: 215 };
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    Object.defineProperty(el, key, { configurable: true, get: () => state[key] });
  }
  (el as unknown as { __state: typeof state }).__state = state;
  document.body.appendChild(el);
  return el;
}
const stateOf = (el: HTMLMediaElement) => (el as unknown as { __state: { paused: boolean; ended: boolean } }).__state;

function setMediaSession(md: { title: string; artist?: string; album?: string } | null) {
  Object.defineProperty(window.navigator, 'mediaSession', {
    configurable: true,
    value: { metadata: md ? { artwork: [], artist: '', album: '', ...md } : null },
  });
}

describe('MediaDetector', () => {
  let emitted: Array<MediaInfo | null>;
  let detector: MediaDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    document.title = 'Example';
    emitted = [];
    setMediaSession({ title: 'Song A', artist: 'Band' });
    detector = new MediaDetector(window, (m) => emitted.push(m));
    detector.start();
  });
  afterEach(() => {
    detector.stop();
    vi.useRealTimers();
  });

  const play = (el: HTMLMediaElement) => {
    stateOf(el).paused = false;
    el.dispatchEvent(new Event('play'));
    el.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(300);
  };

  it('detecta o início da reprodução e lê a Media Session', () => {
    const el = fakeMedia();
    play(el);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ title: 'Song A', artist: 'Band', playback: 'playing', source: 'mediasession', durationSec: 215 });
  });

  it('detecta pausa e fim da mídia', () => {
    const el = fakeMedia();
    play(el);
    stateOf(el).paused = true;
    el.dispatchEvent(new Event('pause'));
    vi.advanceTimersByTime(300);
    expect(emitted.at(-1)).toMatchObject({ playback: 'paused' });

    stateOf(el).paused = false;
    el.dispatchEvent(new Event('play'));
    stateOf(el).ended = true;
    el.dispatchEvent(new Event('ended'));
    vi.advanceTimersByTime(300);
    expect(emitted.at(-1)).toMatchObject({ playback: 'ended' });
  });

  it('detecta troca de faixa sem recarregar a página (polling da Media Session)', () => {
    const el = fakeMedia();
    play(el);
    setMediaSession({ title: 'Song B', artist: 'Other Band' });
    vi.advanceTimersByTime(2100);
    expect(emitted.map((m) => m?.title)).toEqual(['Song A', 'Song B']);
  });

  it('não emite de novo quando nada mudou', () => {
    const el = fakeMedia();
    play(el);
    vi.advanceTimersByTime(10_000);
    expect(emitted).toHaveLength(1);
  });

  it('ignora vídeos decorativos (loop curto)', () => {
    const el = fakeMedia();
    el.loop = true;
    Object.defineProperty(el, 'duration', { configurable: true, get: () => 8 });
    play(el);
    expect(emitted).toHaveLength(0);
  });

  it('com várias mídias, escolhe a que está tocando', () => {
    const idle = fakeMedia('audio');
    const active = fakeMedia('video');
    idle.dispatchEvent(new Event('loadedmetadata'));
    play(active);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.playback).toBe('playing');
  });

  it('não reporta nada para elementos que nunca tocaram', () => {
    const el = fakeMedia();
    el.dispatchEvent(new Event('loadedmetadata'));
    vi.advanceTimersByTime(500);
    expect(emitted).toHaveLength(0);
  });

  it('detecta mídia fora do DOM avisada pelo page-hook e pede o estado atual ao iniciar', () => {
    const syncs: number[] = [];
    document.addEventListener('m2s:sync', () => syncs.push(1));
    detector.refresh(); // dispara um novo pedido de sincronização
    expect(syncs.length).toBeGreaterThan(0);

    const announce = (over: Record<string, unknown>) =>
      document.dispatchEvent(new CustomEvent('m2s:media', { detail: JSON.stringify({ id: 7, type: 'playing', paused: false, ended: false, readyState: 4, duration: 200, loop: false, muted: false, volume: 1, tag: 'AUDIO', ...over }) }));
    announce({});
    vi.advanceTimersByTime(300);
    expect(emitted.at(-1)).toMatchObject({ title: 'Song A', playback: 'playing', durationSec: 200 });
    announce({ type: 'pause', paused: true });
    vi.advanceTimersByTime(300);
    expect(emitted.at(-1)).toMatchObject({ playback: 'paused' });
  });

  it('ignora avisos do page-hook malformados', () => {
    document.dispatchEvent(new CustomEvent('m2s:media', { detail: '{não é json' }));
    document.dispatchEvent(new CustomEvent('m2s:media', { detail: JSON.stringify({ id: 'x' }) }));
    document.dispatchEvent(new CustomEvent('m2s:media', { detail: 42 }));
    vi.advanceTimersByTime(500);
    expect(emitted).toHaveLength(0);
  });

  it('sem título utilizável, cai para o título da aba', () => {
    setMediaSession(null);
    document.title = 'Podcast #5 | Example';
    const el = fakeMedia();
    play(el);
    expect(emitted[0]).toMatchObject({ title: 'Podcast #5 - Example', source: 'document' });
  });
});
