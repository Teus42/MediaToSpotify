import type { SiteAdapter } from './types';
import { soundcloudAdapter } from './soundcloud';
import { youtubeAdapter } from './youtube';
import { ytMusicAdapter } from './ytmusic';

export const ADAPTERS: readonly SiteAdapter[] = [youtubeAdapter, ytMusicAdapter, soundcloudAdapter];

export function adapterFor(host: string): SiteAdapter | undefined {
  return ADAPTERS.find((a) => a.matches(host));
}

export type { AdapterResult, RawMeta, SiteAdapter } from './types';
