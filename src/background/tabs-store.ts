import { getSession, setSession, type TabEntry } from '../shared/storage';
import type { MediaInfo } from '../shared/types';
import { Mutex } from './mutex';

/**
 * Estado de mídia por aba, em chrome.storage.session — sobrevive à suspensão do service worker
 * (variáveis de módulo não sobreviveriam) e some ao fechar o navegador.
 */
const mutex = new Mutex();

async function load(): Promise<Record<string, TabEntry>> {
  return (await getSession('tabs')) ?? {};
}

export const tabsStore = {
  upsert(tabId: number, media: MediaInfo): Promise<void> {
    return mutex.run(async () => {
      const tabs = await load();
      const prev = tabs[String(tabId)];
      tabs[String(tabId)] = {
        media,
        lastPlayingAt: media.playback === 'playing' ? media.updatedAt : (prev?.lastPlayingAt ?? 0),
      };
      await setSession('tabs', tabs);
    });
  },

  remove(tabId: number): Promise<void> {
    return mutex.run(async () => {
      const tabs = await load();
      if (!(String(tabId) in tabs)) return;
      delete tabs[String(tabId)];
      await setSession('tabs', tabs);
    });
  },

  get(tabId: number): Promise<TabEntry | undefined> {
    return load().then((t) => t[String(tabId)]);
  },

  /**
   * Escolhe a mídia "atual":
   *  1. a da aba pedida (ex.: a aba ativa quando o popup abre), mesmo pausada/encerrada;
   *  2. senão, a que está tocando há menos tempo em qualquer aba;
   *  3. senão, nada (abas com mídia pausada em segundo plano não são "em reprodução").
   */
  async pickCurrent(preferredTabId?: number): Promise<{ tabId: number; entry: TabEntry } | null> {
    const tabs = await load();
    if (preferredTabId !== undefined) {
      const entry = tabs[String(preferredTabId)];
      if (entry) return { tabId: preferredTabId, entry };
    }
    let best: { tabId: number; entry: TabEntry } | null = null;
    for (const [id, entry] of Object.entries(tabs)) {
      if (entry.media.playback !== 'playing') continue;
      if (!best || entry.lastPlayingAt > best.entry.lastPlayingAt) best = { tabId: Number(id), entry };
    }
    return best;
  },
};
