import { getSettings, saveSettings } from '../shared/storage';
import { describeError } from '../popup/format';
import { ApiError, send } from '../popup/api';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const clientId = $<HTMLInputElement>('clientId');
const redirect = $<HTMLInputElement>('redirect');
const saveMsg = $('saveMsg');
const authStatus = $('authStatus');
const authMsg = $('authMsg');
const connectBtn = $<HTMLButtonElement>('connect');
const disconnectBtn = $<HTMLButtonElement>('disconnect');
const autoSearch = $<HTMLInputElement>('autoSearch');
const market = $<HTMLInputElement>('market');
const sitesList = $('sites');
const clearMsg = $('clearMsg');

function flash(el: HTMLElement, text: string, cls: 'ok' | 'bad' = 'ok'): void {
  el.textContent = text;
  el.className = cls;
  setTimeout(() => {
    if (el.textContent === text) el.textContent = '';
  }, 4000);
}

async function refreshAuth(): Promise<void> {
  try {
    const snap = await send({ type: 'snapshot:get' });
    const { configured, connected, user } = snap.auth;
    if (connected) {
      authStatus.textContent = `Conectado${user ? ` como ${user.displayName ?? user.id}` : ''}.`;
      authStatus.className = 'ok';
    } else {
      authStatus.textContent = configured ? 'Não conectado.' : 'Informe e salve o Client ID para poder conectar.';
      authStatus.className = '';
    }
    connectBtn.disabled = !configured || connected;
    disconnectBtn.disabled = !connected;
  } catch (err) {
    authStatus.textContent = err instanceof Error ? err.message : 'Erro ao consultar o estado.';
    authStatus.className = 'bad';
  }
}

async function refreshSites(): Promise<void> {
  const sites = await send({ type: 'sites:list' }).catch(() => []);
  sitesList.replaceChildren();
  if (sites.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Nenhum site extra habilitado.';
    sitesList.append(li);
    return;
  }
  for (const { origin } of sites) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = origin;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remover';
    remove.addEventListener('click', async () => {
      await send({ type: 'sites:disable', origin }).catch(() => undefined);
      await refreshSites();
    });
    li.append(name, remove);
    sitesList.append(li);
  }
}

async function init(): Promise<void> {
  const settings = await getSettings();
  clientId.value = settings.clientId;
  autoSearch.checked = settings.autoSearch;
  market.value = settings.market;
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="openMode"]')) {
    radio.checked = radio.value === settings.openMode;
  }
  redirect.value = chrome.identity.getRedirectURL();

  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(redirect.value);
      flash(saveMsg, 'Redirect URI copiado.');
    } catch {
      redirect.select();
    }
  });

  $('saveClient').addEventListener('click', async () => {
    const value = clientId.value.trim();
    if (value && !/^[A-Za-z0-9]{16,64}$/.test(value)) {
      flash(saveMsg, 'O Client ID parece inválido (letras e números, sem espaços).', 'bad');
      return;
    }
    await saveSettings({ clientId: value });
    flash(saveMsg, 'Client ID salvo.');
    await refreshAuth();
  });

  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    authMsg.textContent = 'Abrindo a janela de login do Spotify…';
    try {
      await send({ type: 'auth:login' });
      authMsg.textContent = '';
    } catch (err) {
      const view = describeError(err instanceof ApiError ? err.info : { kind: 'internal', message: String(err) });
      authMsg.textContent = `${view.title}. ${view.detail}`;
    }
    await refreshAuth();
  });

  disconnectBtn.addEventListener('click', async () => {
    await send({ type: 'auth:logout' }).catch(() => undefined);
    authMsg.textContent = 'Desconectado. Tokens, perfil e cache de playlists foram apagados.';
    await refreshAuth();
  });

  autoSearch.addEventListener('change', () => void saveSettings({ autoSearch: autoSearch.checked }));
  market.addEventListener('change', async () => {
    const v = market.value.trim().toUpperCase();
    if (v && !/^[A-Z]{2}$/.test(v)) {
      flash(saveMsg, 'Use um código de país de 2 letras (ex.: BR, US).', 'bad');
      return;
    }
    await saveSettings({ market: v });
    flash(saveMsg, 'País salvo.');
  });
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="openMode"]')) {
    radio.addEventListener('change', () => {
      if (radio.checked) void saveSettings({ openMode: radio.value === 'web' ? 'web' : 'app' });
    });
  }

  $('clearCache').addEventListener('click', async () => {
    await send({ type: 'cache:clear' }).catch(() => undefined);
    flash(clearMsg, 'Cache limpo.');
  });

  await Promise.all([refreshAuth(), refreshSites()]);
}

void init();
