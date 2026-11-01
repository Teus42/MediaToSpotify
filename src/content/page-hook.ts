/**
 * Script do "mundo principal" da página (content script com `world: "MAIN"`).
 *
 * Por quê: muitos players (SoundCloud, por exemplo) criam o <audio> com `new Audio()` e nunca o
 * inserem no DOM. Eventos de mídia de elementos fora do DOM não chegam ao `document`, então o
 * detector (que roda no mundo isolado) não os vê. Aqui observamos `HTMLMediaElement.prototype.play`
 * e repassamos o estado desses elementos soltos por um CustomEvent no `document`.
 *
 * O que NÃO faz: não lê áudio, não altera a reprodução (chama o `play` original e devolve o mesmo
 * retorno) e ignora elementos que já estão no DOM (esses o detector já enxerga).
 */

declare global {
  interface Window {
    __m2sHook?: boolean;
  }
}

export const REMOTE_MEDIA_EVENT = 'm2s:media';
/** O detector (que inicia depois do hook) pede para reanunciar os elementos já conhecidos. */
export const SYNC_EVENT = 'm2s:sync';

(() => {
  if (window.__m2sHook) return;
  window.__m2sHook = true;

  const EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'durationchange'] as const;
  let seq = 0;
  const ids = new WeakMap<HTMLMediaElement, number>();
  const watched = new WeakSet<HTMLMediaElement>();
  const known: Array<WeakRef<HTMLMediaElement>> = [];

  const idOf = (el: HTMLMediaElement): number => {
    let id = ids.get(el);
    if (!id) {
      id = ++seq;
      ids.set(el, id);
    }
    return id;
  };

  const announce = (el: HTMLMediaElement, type: string): void => {
    if (el.isConnected) return; // elementos no DOM já são tratados pelo detector
    const detail = JSON.stringify({
      id: idOf(el),
      type,
      paused: el.paused,
      ended: el.ended,
      readyState: el.readyState,
      duration: Number.isFinite(el.duration) ? el.duration : null,
      loop: el.loop,
      muted: el.muted,
      volume: el.volume,
      tag: el.tagName,
    });
    document.dispatchEvent(new CustomEvent(REMOTE_MEDIA_EVENT, { detail }));
  };

  const watch = (el: HTMLMediaElement): void => {
    if (watched.has(el)) return;
    watched.add(el);
    known.push(new WeakRef(el));
    for (const type of EVENTS) el.addEventListener(type, () => announce(el, type));
  };

  // O hook roda em document_start e o detector só em document_idle: o `play()` pode já ter acontecido.
  document.addEventListener(SYNC_EVENT, () => {
    for (const ref of known) {
      const el = ref.deref();
      if (el) announce(el, 'sync');
    }
  });

  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement, ...args: []): Promise<void> {
    watch(this);
    const result = originalPlay.apply(this, args);
    announce(this, 'play');
    return result;
  };
})();
