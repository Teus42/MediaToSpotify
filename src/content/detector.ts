import type { MediaInfo, PlaybackState } from '../shared/types';
import { extractMetadata, type MediaLike } from './extract';

const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'durationchange'] as const;
/** Evento enviado pelo page-hook (mundo principal) para elementos de mídia fora do DOM. */
const REMOTE_MEDIA_EVENT = 'm2s:media';
const SYNC_EVENT = 'm2s:sync';
const POLL_MS = 2000;
const DEBOUNCE_MS = 250;

type Emit = (media: MediaInfo | null) => void;

/**
 * Acompanha os elementos <video>/<audio> da página e emite um MediaInfo sempre que algo
 * relevante muda (play/pause/fim, troca de faixa sem recarregar a página, título que muda).
 *
 * Estratégia:
 *  - ouve os eventos de mídia na fase de captura do document (eles não "borbulham"), o que
 *    cobre elementos criados depois sem varrer o DOM;
 *  - observa o <title> e eventos de navegação SPA (YouTube: `yt-navigate-finish`);
 *  - enquanto algo toca, relê os metadados a cada 2 s, porque a Media Session não emite evento
 *    quando `metadata` muda;
 *  - só emite quando a "assinatura" dos metadados muda — evita mensagens redundantes.
 */
/** Espelho de um <audio>/<video> fora do DOM, atualizado pelos avisos do page-hook. */
class RemoteMedia implements MediaLike {
  paused = true;
  ended = false;
  readyState = 0;
  duration = NaN;
  loop = false;
  muted = false;
  volume = 1;
  tagName = 'AUDIO';
  title = '';
  readonly isConnected = true; // não é um nó do DOM; "true" evita que seja descartado como desconectado
  hasAttribute(): boolean {
    return false;
  }
  getAttribute(): string | null {
    return null;
  }
}

export class MediaDetector {
  private readonly tracked = new Set<MediaLike>();
  private readonly remote = new Map<number, RemoteMedia>();
  private readonly lastPlayedAt = new WeakMap<MediaLike, number>();
  private current: MediaLike | null = null;
  private lastSignature = '';
  private lastEmittedMedia = false;
  private timer: number | undefined;
  private poll: number | undefined;
  private titleObserver: MutationObserver | undefined;
  private readonly onMediaEvent = (e: Event) => this.handleMediaEvent(e);
  private readonly onRemoteMedia = (e: Event) => this.handleRemoteMedia(e);
  private readonly onNavigate = () => this.schedule();

  constructor(
    private readonly win: Window & typeof globalThis,
    private readonly emit: Emit,
  ) {}

  start(): void {
    const doc = this.win.document;
    for (const type of MEDIA_EVENTS) doc.addEventListener(type, this.onMediaEvent, true);
    doc.addEventListener(REMOTE_MEDIA_EVENT, this.onRemoteMedia);
    doc.addEventListener('yt-navigate-finish', this.onNavigate, true);
    this.win.addEventListener('popstate', this.onNavigate);

    const titleEl = doc.querySelector('title');
    if (titleEl) {
      this.titleObserver = new MutationObserver(() => this.schedule());
      this.titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }

    doc.querySelectorAll<HTMLMediaElement>('video, audio').forEach((el) => this.track(el));
    // Elementos fora do DOM que já tocaram antes de começarmos a escutar: peça o estado atual ao page-hook.
    doc.dispatchEvent(new CustomEvent(SYNC_EVENT));
    this.schedule();
  }

  stop(): void {
    const doc = this.win.document;
    for (const type of MEDIA_EVENTS) doc.removeEventListener(type, this.onMediaEvent, true);
    doc.removeEventListener(REMOTE_MEDIA_EVENT, this.onRemoteMedia);
    doc.removeEventListener('yt-navigate-finish', this.onNavigate, true);
    this.win.removeEventListener('popstate', this.onNavigate);
    this.titleObserver?.disconnect();
    this.win.clearTimeout(this.timer);
    this.win.clearInterval(this.poll);
    this.poll = undefined;
  }

  /** Esquece o que já foi enviado e reavalia (ex.: página restaurada do bfcache, estado perdido no worker). */
  refresh(): void {
    this.win.document.dispatchEvent(new CustomEvent(SYNC_EVENT));
    this.lastSignature = '';
    this.lastEmittedMedia = false;
    this.schedule();
  }

  /** Reavalia agora (útil para testes). */
  evaluateNow(): void {
    this.evaluate();
  }

  private handleMediaEvent(e: Event): void {
    const el = e.target;
    if (!(el instanceof this.win.HTMLMediaElement)) return;
    this.track(el);
    if (e.type === 'play' || e.type === 'playing') this.lastPlayedAt.set(el, Date.now());
    this.schedule();
  }

  /** Estado de um elemento fora do DOM, vindo do page-hook. Os dados são validados campo a campo. */
  private handleRemoteMedia(e: Event): void {
    const raw = (e as CustomEvent).detail;
    let d: Record<string, unknown>;
    try {
      d = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return;
    }
    if (typeof d.id !== 'number') return;
    let m = this.remote.get(d.id);
    if (!m) {
      if (this.remote.size >= 20) return; // limite defensivo contra páginas que criam elementos sem parar
      m = new RemoteMedia();
      this.remote.set(d.id, m);
      this.tracked.add(m);
    }
    m.paused = d.paused !== false;
    m.ended = d.ended === true;
    m.readyState = typeof d.readyState === 'number' ? d.readyState : 0;
    m.duration = typeof d.duration === 'number' ? d.duration : NaN;
    m.loop = d.loop === true;
    m.muted = d.muted === true;
    m.volume = typeof d.volume === 'number' ? d.volume : 1;
    m.tagName = d.tag === 'VIDEO' ? 'VIDEO' : 'AUDIO';
    if (d.type === 'play' || d.type === 'playing') this.lastPlayedAt.set(m, Date.now());
    this.schedule();
  }

  private track(el: MediaLike): void {
    this.tracked.add(el);
  }

  private schedule(): void {
    this.win.clearTimeout(this.timer);
    this.timer = this.win.setTimeout(() => this.evaluate(), DEBOUNCE_MS);
  }

  /** Vídeos decorativos (loop curto, mudos com autoplay) não são "mídia que o usuário ouve". */
  private isDecorative(el: MediaLike): boolean {
    const d = el.duration;
    if (el.loop && Number.isFinite(d) && d < 60) return true;
    if (el.muted && el.hasAttribute('autoplay') && el.tagName === 'VIDEO') return true;
    return false;
  }

  private isPlaying(el: MediaLike): boolean {
    return !el.paused && !el.ended && el.readyState > 2;
  }

  /** Escolhe o elemento "atual": o que toca (preferindo o audível/mais recente), senão o último usado. */
  private pickElement(): MediaLike | null {
    for (const el of [...this.tracked]) if (!el.isConnected) this.tracked.delete(el);
    const candidates = [...this.tracked].filter((el) => !this.isDecorative(el));
    const playing = candidates.filter((el) => this.isPlaying(el));
    const rank = (el: MediaLike) => (el.muted || el.volume === 0 ? 0 : 1_000_000_000_000_000) + (this.lastPlayedAt.get(el) ?? 0);
    if (playing.length > 0) return playing.sort((a, b) => rank(b) - rank(a))[0] ?? null;
    if (this.current && candidates.includes(this.current)) return this.current;
    return candidates.sort((a, b) => (this.lastPlayedAt.get(b) ?? 0) - (this.lastPlayedAt.get(a) ?? 0))[0] ?? null;
  }

  private playbackOf(el: MediaLike): PlaybackState {
    if (el.ended) return 'ended';
    return el.paused ? 'paused' : 'playing';
  }

  private evaluate(): void {
    const doc = this.win.document;
    const el = this.pickElement();
    const playing = !!el && this.isPlaying(el);
    this.syncPolling(playing);

    // Sem elemento de mídia nesta página: nada a reportar.
    if (!el) return this.reportNone();
    // Elemento que nunca tocou (só carregado): não é "mídia atual".
    if (!this.lastPlayedAt.has(el) && !playing) return this.reportNone();

    const result = extractMetadata({
      doc,
      loc: this.win.location,
      mediaSession: this.win.navigator.mediaSession,
      element: el,
    });
    if (result.kind === 'hold') return;
    if (result.kind === 'none') return this.reportNone();

    this.current = el;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : undefined;
    const media: MediaInfo = {
      title: result.meta.title,
      host: this.win.location.hostname,
      playback: this.playbackOf(el),
      source: result.source,
      updatedAt: Date.now(),
    };
    if (result.meta.artist) media.artist = result.meta.artist;
    if (result.meta.album) media.album = result.meta.album;
    if (result.meta.channel) media.channel = result.meta.channel;
    if (result.meta.artworkUrl) media.artworkUrl = result.meta.artworkUrl;
    if (duration) media.durationSec = duration;

    const signature = JSON.stringify([media.title, media.artist, media.album, media.channel, media.playback, media.durationSec, media.source]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.lastEmittedMedia = true;
    this.emit(media);
  }

  private reportNone(): void {
    if (!this.lastEmittedMedia) return;
    this.lastEmittedMedia = false;
    this.lastSignature = '';
    this.emit(null);
  }

  private syncPolling(playing: boolean): void {
    if (playing && this.poll === undefined) {
      this.poll = this.win.setInterval(() => this.evaluate(), POLL_MS);
    } else if (!playing && this.poll !== undefined) {
      this.win.clearInterval(this.poll);
      this.poll = undefined;
    }
  }
}
