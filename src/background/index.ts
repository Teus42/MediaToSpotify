import type { ContentMessage, Request } from '../shared/messages';
import { clearBadge } from './badge';
import { Router } from './router';
import { createServices } from './services';
import { sites } from './sites';

/**
 * Service worker (Manifest V3). Os listeners são registrados de forma síncrona no topo do módulo —
 * requisito para o Chrome acordar o worker com o evento certo — e todo estado fica em
 * chrome.storage, então suspensões e reinicializações são seguras.
 */

const router = new Router(createServices());
const extensionOrigin = chrome.runtime.getURL('');

const CONTENT_TYPES = new Set(['media:update', 'media:gone']);

/** Só páginas da própria extensão (popup/opções) podem pedir operações privilegiadas. */
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(extensionOrigin);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const type = (message as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || sender.id !== chrome.runtime.id) return false;

  // Content script (página web, não confiável): apenas relatar mídia, a partir de uma aba real.
  if (CONTENT_TYPES.has(type)) {
    const tabId = sender.tab?.id;
    if (tabId === undefined || !sender.url || isExtensionPage(sender)) return false;
    let host: string;
    try {
      host = new URL(sender.url).hostname;
    } catch {
      return false;
    }
    void router.handleContent(message as ContentMessage, tabId, host).catch(() => undefined);
    return false;
  }

  if (!isExtensionPage(sender)) return false;
  void router.respond(message as Request).then(sendResponse);
  return true; // resposta assíncrona
});

chrome.tabs.onRemoved.addListener((tabId) => void router.forgetTab(tabId));

// Navegação completa na aba: a mídia anterior deixou de existir (SPAs são tratadas no content script).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    void router.forgetTab(tabId);
    void clearBadge(tabId);
  }
});

chrome.runtime.onInstalled.addListener(() => void sites.reconcile().catch(() => undefined));
chrome.runtime.onStartup.addListener(() => void sites.reconcile().catch(() => undefined));

// Defesa em profundidade: o storage nunca é exposto a content scripts (este já é o padrão).
void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
void chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
