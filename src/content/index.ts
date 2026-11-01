import type { ContentMessage } from '../shared/messages';
import { MediaDetector } from './detector';

/**
 * Content script. Só detecta e relata metadados de mídia ao service worker.
 * Não faz chamadas de rede, não acessa tokens e não lê nada além do player e dos metadados
 * que a própria página expõe.
 */

declare global {
  interface Window {
    __mediaToSpotifyLoaded?: boolean;
  }
}

function send(message: ContentMessage): void {
  try {
    // Contexto invalidado (extensão recarregada/atualizada): pare de tentar.
    if (!chrome.runtime?.id) {
      detector.stop();
      return;
    }
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    detector.stop();
  }
}

// Evita instalar duas vezes (script registrado + injeção manual via activeTab).
let detector: MediaDetector;
if (!window.__mediaToSpotifyLoaded) {
  window.__mediaToSpotifyLoaded = true;
  detector = new MediaDetector(window, (media) => send(media ? { type: 'media:update', media } : { type: 'media:gone' }));
  detector.start();
  window.addEventListener('pagehide', () => send({ type: 'media:gone' }));
  // Voltar à página pelo bfcache: o worker já apagou o estado no `pagehide`, então reenviamos.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) detector.refresh();
  });
}
