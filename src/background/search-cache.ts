import { SEARCH_CACHE_MAX_ENTRIES, SEARCH_CACHE_TTL_FOUND_MS, SEARCH_CACHE_TTL_MISS_MS } from '../shared/constants';
import { getLocal, removeLocal, setLocal, type CachedSearch } from '../shared/storage';
import type { SearchOutcome } from '../shared/types';
import { Mutex } from './mutex';

/**
 * Cache de buscas (chrome.storage.local), para não repetir requisições da mesma mídia.
 * Resultados encontrados duram 7 dias; "não encontrado" só 30 min (o catálogo e as regras de
 * busca mudam). Limite de 150 entradas, descartando as mais antigas.
 */
const mutex = new Mutex();

function isFresh(entry: CachedSearch, now: number): boolean {
  const ttl = entry.outcome.status === 'found' ? SEARCH_CACHE_TTL_FOUND_MS : SEARCH_CACHE_TTL_MISS_MS;
  return now - entry.at < ttl;
}

export const searchCache = {
  async get(key: string, now = Date.now()): Promise<SearchOutcome | undefined> {
    const all = (await getLocal('searchCache')) ?? {};
    const entry = all[key];
    return entry && isFresh(entry, now) ? entry.outcome : undefined;
  },

  put(key: string, outcome: SearchOutcome, now = Date.now()): Promise<void> {
    return mutex.run(async () => {
      const all = (await getLocal('searchCache')) ?? {};
      all[key] = { outcome, at: now };
      const entries = Object.entries(all).filter(([, e]) => isFresh(e, now));
      entries.sort((a, b) => b[1].at - a[1].at);
      await setLocal('searchCache', Object.fromEntries(entries.slice(0, SEARCH_CACHE_MAX_ENTRIES)));
    });
  },

  delete(key: string): Promise<void> {
    return mutex.run(async () => {
      const all = (await getLocal('searchCache')) ?? {};
      if (!(key in all)) return;
      delete all[key];
      await setLocal('searchCache', all);
    });
  },

  clear(): Promise<void> {
    return mutex.run(() => removeLocal('searchCache'));
  },
};
