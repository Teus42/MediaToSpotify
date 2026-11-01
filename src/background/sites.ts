import { AppError } from '../shared/errors';
import type { SiteEntry } from '../shared/messages';
import { getLocal, setLocal } from '../shared/storage';
import { Mutex } from './mutex';

/**
 * Sites adicionais escolhidos pelo usuário. O padrão da extensão é NÃO ter acesso a todos os sites:
 *  - "Detectar nesta aba" usa activeTab (injeção única, só enquanto a aba não navegar);
 *  - "Sempre neste site" pede a permissão do site (optional_host_permissions) e registra o
 *    content script dinamicamente — apenas para aquele origin.
 */
const mutex = new Mutex();

export function originPattern(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new AppError('bad-request', 'Endereço de site inválido.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('bad-request', 'Só é possível habilitar sites http(s).');
  }
  return `${url.origin}/*`;
}

function scriptId(origin: string): string {
  return 'site-' + origin.replace(/[^a-z0-9]/gi, '_');
}

/** Detector (mundo isolado) + page-hook (mundo principal, para <audio> fora do DOM). */
async function register(origin: string): Promise<void> {
  const id = scriptId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id, `${id}-hook`] });
  const have = new Set(existing.map((s) => s.id));
  const matches = [originPattern(origin)];
  const toRegister: chrome.scripting.RegisteredContentScript[] = [];
  if (!have.has(id)) toRegister.push({ id, matches, js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true });
  if (!have.has(`${id}-hook`)) {
    toRegister.push({ id: `${id}-hook`, matches, js: ['page-hook.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true });
  }
  if (toRegister.length > 0) await chrome.scripting.registerContentScripts(toRegister);
}

export const sites = {
  async list(): Promise<SiteEntry[]> {
    return ((await getLocal('customSites')) ?? []).map((origin) => ({ origin }));
  },

  /** A permissão já deve ter sido concedida pelo usuário (o popup chama permissions.request). */
  enable(rawOrigin: string, tabId?: number): Promise<void> {
    return mutex.run(async () => {
      const pattern = originPattern(rawOrigin);
      const origin = new URL(rawOrigin).origin;
      const granted = await chrome.permissions.contains({ origins: [pattern] });
      if (!granted) throw new AppError('forbidden', 'Permissão para este site não concedida.');
      await register(origin);
      const list = (await getLocal('customSites')) ?? [];
      if (!list.includes(origin)) await setLocal('customSites', [...list, origin]);
      if (tabId !== undefined) {
        await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['page-hook.js'] });
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      }
    });
  },

  disable(rawOrigin: string): Promise<void> {
    return mutex.run(async () => {
      const origin = new URL(rawOrigin).origin;
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin), `${scriptId(origin)}-hook`] });
      } catch {
        /* já não estava registrado */
      }
      await chrome.permissions.remove({ origins: [originPattern(origin)] });
      const list = (await getLocal('customSites')) ?? [];
      await setLocal('customSites', list.filter((o) => o !== origin));
    });
  },

  /** Reconcilia registros com a lista salva (ex.: após atualizar a extensão). */
  reconcile(): Promise<void> {
    return mutex.run(async () => {
      const list = (await getLocal('customSites')) ?? [];
      const keep: string[] = [];
      for (const origin of list) {
        const granted = await chrome.permissions.contains({ origins: [originPattern(origin)] });
        if (!granted) continue; // o usuário revogou a permissão pelo Chrome
        await register(origin);
        keep.push(origin);
      }
      if (keep.length !== list.length) await setLocal('customSites', keep);
    });
  },
};
