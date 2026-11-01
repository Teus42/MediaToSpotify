import { mediaKey } from '../shared/media-key';
import { AppError, toErrorInfo } from '../shared/errors';
import { getSession, setSession, type SearchState } from '../shared/storage';
import type { ErrorInfo, MediaInfo, SearchOutcome, Settings } from '../shared/types';
import { parseMediaTitle } from '../metadata/title-parser';
import type { SpotifyClient } from '../spotify/client';
import { resolveMarket, searchTrack } from '../spotify/search';
import { Mutex } from './mutex';
import { searchCache } from './search-cache';

/** "Pesquisando" sem processo vivo por mais que isso = o service worker foi suspenso no meio. */
const STALE_SEARCHING_MS = 20_000;
/** Após um erro, não repete automaticamente por este período (o usuário pode usar "Tentar de novo"). */
const ERROR_COOLDOWN_MS = 60_000;

export interface SearchServiceDeps {
  getSettings(): Promise<Settings>;
  isConnected(): Promise<boolean>;
  client: SpotifyClient;
  now(): number;
  language(): string | undefined;
  /** Chamado ao terminar (outcome = null em caso de erro), para atualizar o selo do ícone. */
  onResult?(key: string, outcome: SearchOutcome | null): void;
}

export interface SearchStatus {
  phase: 'idle' | 'searching' | 'done' | 'error';
  outcome?: SearchOutcome;
  error?: ErrorInfo;
}

const stateMutex = new Mutex();

function patchState(key: string, state: SearchState | null): Promise<void> {
  return stateMutex.run(async () => {
    const all = (await getSession('searchState')) ?? {};
    if (state) all[key] = state;
    else delete all[key];
    // Mantém o mapa pequeno.
    const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 50);
    await setSession('searchState', Object.fromEntries(entries));
  });
}

/**
 * Orquestra a pesquisa de uma mídia no Spotify:
 *  cache → deduplicação de buscas em andamento → janela global de rate limit → busca → cache.
 */
export class SearchService {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly deps: SearchServiceDeps) {}

  async status(media: MediaInfo): Promise<SearchStatus> {
    const key = mediaKey(media);
    const cached = await searchCache.get(key, this.deps.now());
    if (cached) return { phase: 'done', outcome: cached };

    const state = ((await getSession('searchState')) ?? {})[key];
    const age = state ? this.deps.now() - state.at : Infinity;
    if (state?.phase === 'searching' && (this.inflight.has(key) || age < STALE_SEARCHING_MS)) return { phase: 'searching' };
    if (state?.phase === 'error' && age < ERROR_COOLDOWN_MS) return { phase: 'error', error: state.error };
    return { phase: 'idle' };
  }

  /**
   * Inicia a busca se necessário. Com `wait`, só resolve quando a busca termina
   * (usado por "Tentar de novo"); sem ele, resolve assim que a busca foi iniciada.
   */
  async start(media: MediaInfo, options: { force?: boolean; wait?: boolean } = {}): Promise<void> {
    const key = mediaKey(media);
    const now = this.deps.now();
    const force = options.force === true;

    const running = this.inflight.get(key);
    if (running) return options.wait ? running : undefined;
    if (!force && (await searchCache.get(key, now))) return;

    const settings = await this.deps.getSettings();
    if (!force && !settings.autoSearch) return;
    if (!settings.clientId.trim() || !(await this.deps.isConnected())) return;

    if (!force) {
      const prev = ((await getSession('searchState')) ?? {})[key];
      if (prev?.phase === 'error' && now - prev.at < ERROR_COOLDOWN_MS) return;
    }

    const until = (await getSession('rateLimitedUntil')) ?? 0;
    if (until > now) {
      const retryAfterSec = Math.ceil((until - now) / 1000);
      const error = new AppError('rate-limit', 'O Spotify limitou as requisições. Tente de novo em instantes.', { retryAfterSec }).toInfo();
      await patchState(key, { phase: 'error', at: now, error });
      return;
    }

    if (force) await searchCache.delete(key);
    await patchState(key, { phase: 'searching', at: now });
    const promise = this.execute(media, key, settings).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    if (options.wait) await promise;
  }

  private async execute(media: MediaInfo, key: string, settings: Settings): Promise<void> {
    try {
      const parsed = parseMediaTitle({
        title: media.title,
        artist: media.artist,
        channel: media.channel,
        album: media.album,
      });
      const outcome = await searchTrack(this.deps.client, parsed, {
        market: resolveMarket(settings.market, this.deps.language()),
        durationSec: media.durationSec,
        now: this.deps.now,
      });
      await searchCache.put(key, outcome, this.deps.now());
      await patchState(key, null);
      this.deps.onResult?.(key, outcome);
    } catch (err) {
      const info = toErrorInfo(err);
      if (info.kind === 'rate-limit') {
        await setSession('rateLimitedUntil', this.deps.now() + (info.retryAfterSec ?? 30) * 1000);
      }
      await patchState(key, { phase: 'error', at: this.deps.now(), error: info });
      this.deps.onResult?.(key, null);
    }
  }
}
