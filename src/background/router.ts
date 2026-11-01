import { SEARCH_SETTLE_MS } from '../shared/constants';
import { AppError, toErrorInfo } from '../shared/errors';
import { manualSearchUrl, mediaKey } from '../shared/media-key';
import type { ContentMessage, Request, ResponseMap, Response, Snapshot } from '../shared/messages';
import { getLocal, getSettings, setLocal } from '../shared/storage';
import type { MediaInfo, PlaybackState, SpotifyUser, TitleSource } from '../shared/types';
import { manualSearchText } from '../matching/queries';
import { parseMediaTitle } from '../metadata/title-parser';
import type { AuthService } from '../spotify/auth';
import type { PlaylistService } from './playlist-service';
import type { SearchService } from './search-service';
import { sites } from './sites';
import { searchCache } from './search-cache';
import { tabsStore } from './tabs-store';

export interface Services {
  auth: AuthService;
  search: SearchService;
  playlists: PlaylistService;
  /** Perfil do usuário (busca na API se ainda não estiver salvo). */
  ensureUser(): Promise<SpotifyUser>;
  now(): number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/* ------------------------------------------------------------------ */
/* Mensagens vindas dos content scripts                                 */
/* ------------------------------------------------------------------ */

const PLAYBACK: readonly PlaybackState[] = ['playing', 'paused', 'ended'];
const SOURCES: readonly TitleSource[] = ['site', 'mediasession', 'element', 'document'];

function str(v: unknown, max = 300): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** O content script roda em páginas não confiáveis: validamos tudo e ignoramos o `host` enviado. */
export function sanitizeMedia(raw: unknown, host: string, now: number): MediaInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title);
  if (!title) return null;
  const playback = PLAYBACK.includes(r.playback as PlaybackState) ? (r.playback as PlaybackState) : 'paused';
  const source = SOURCES.includes(r.source as TitleSource) ? (r.source as TitleSource) : 'document';
  const media: MediaInfo = { title, host, playback, source, updatedAt: now };
  const artist = str(r.artist);
  const album = str(r.album);
  const channel = str(r.channel);
  const art = str(r.artworkUrl, 2000);
  if (artist) media.artist = artist;
  if (album) media.album = album;
  if (channel) media.channel = channel;
  if (art && /^https:\/\//i.test(art)) media.artworkUrl = art;
  if (typeof r.durationSec === 'number' && Number.isFinite(r.durationSec) && r.durationSec > 0 && r.durationSec < 86_400) {
    media.durationSec = Math.round(r.durationSec);
  }
  return media;
}

export class Router {
  private readonly timers = new Map<number, unknown>();

  constructor(private readonly s: Services) {}

  async handleContent(msg: ContentMessage, tabId: number, host: string): Promise<void> {
    if (msg.type === 'media:gone') {
      this.cancelTimer(tabId);
      await tabsStore.remove(tabId);
      return;
    }
    if (msg.type !== 'media:update') return;
    const media = sanitizeMedia(msg.media, host, this.s.now());
    if (!media) return;
    await tabsStore.upsert(tabId, media);
    if (media.playback === 'playing') this.scheduleSearch(tabId, media);
  }

  /** Espera o título "assentar" (o DOM do YouTube atualiza um instante depois do play). */
  private scheduleSearch(tabId: number, media: MediaInfo): void {
    this.cancelTimer(tabId);
    const set = this.s.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timers.set(
      tabId,
      set(() => {
        this.timers.delete(tabId);
        void tabsStore.get(tabId).then((entry) => {
          // Só pesquisa se a aba ainda está com a mesma mídia.
          if (entry && mediaKey(entry.media) === mediaKey(media)) return this.s.search.start(entry.media);
        });
      }, SEARCH_SETTLE_MS),
    );
  }

  private cancelTimer(tabId: number): void {
    const handle = this.timers.get(tabId);
    if (handle === undefined) return;
    (this.s.clearTimer ?? ((h) => clearTimeout(h as number)))(handle);
    this.timers.delete(tabId);
  }

  forgetTab(tabId: number): Promise<void> {
    this.cancelTimer(tabId);
    return tabsStore.remove(tabId);
  }

  /* ---------------- popup / opções ---------------- */

  async snapshot(preferredTabId?: number): Promise<Snapshot> {
    const [settings, connected, user] = await Promise.all([getSettings(), this.s.auth.isConnected(), getLocal('user')]);
    const auth: Snapshot['auth'] = { configured: !!settings.clientId.trim(), connected };
    if (connected && user) auth.user = user;

    const current = await tabsStore.pickCurrent(preferredTabId);
    if (!current) return { tabId: null, media: null, search: { phase: 'idle' }, auth };

    const media = current.entry.media;
    const parsed = parseMediaTitle({ title: media.title, artist: media.artist, channel: media.channel });
    const manual = manualSearchUrl(manualSearchText(parsed));

    if (connected) await this.s.search.start(media);
    const status = await this.s.search.status(media);
    return { tabId: current.tabId, media, search: { ...status, manualSearchUrl: manual }, auth };
  }

  async handle<R extends Request>(req: R): Promise<ResponseMap[R['type']]> {
    const result = await this.dispatch(req);
    return result as ResponseMap[R['type']];
  }

  private async dispatch(req: Request): Promise<unknown> {
    switch (req.type) {
      case 'snapshot:get':
        return this.snapshot(req.tabId);

      case 'search:retry': {
        const current = await tabsStore.pickCurrent(req.tabId);
        if (current) await this.s.search.start(current.entry.media, { force: true, wait: true });
        return this.snapshot(req.tabId);
      }

      case 'auth:login': {
        await this.s.auth.login();
        let user: SpotifyUser | undefined;
        try {
          user = await this.s.ensureUser();
        } catch {
          /* o login funcionou; o perfil é só cosmético e será buscado depois */
        }
        return { user };
      }

      case 'auth:logout':
        await this.s.auth.logout();
        return null;

      case 'playlists:list':
        return this.s.playlists.list(req.refresh === true);

      case 'playlists:add':
        return this.s.playlists.add(req.playlistId, req.trackUri, req.allowDuplicate === true);

      case 'playlists:create':
        return this.s.playlists.create(req.name, req.isPublic, req.trackUri);

      case 'sites:enable':
        await sites.enable(req.origin, req.tabId);
        return null;
      case 'sites:disable':
        await sites.disable(req.origin);
        return null;
      case 'sites:list':
        return sites.list();

      case 'cache:clear':
        await searchCache.clear();
        await setLocal('playlistsCache', { playlists: [], fetchedAt: 0 });
        return null;

      default: {
        const exhaustive: never = req;
        throw new AppError('bad-request', `Pedido desconhecido: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** Executa um pedido e o converte no envelope {ok,data}|{ok,error} usado nas mensagens. */
  async respond(req: Request): Promise<Response<unknown>> {
    try {
      return { ok: true, data: await this.handle(req) };
    } catch (err) {
      return { ok: false, error: toErrorInfo(err) };
    }
  }
}
