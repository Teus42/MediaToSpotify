import { fold } from '../metadata/text';
import type { MediaInfo } from './types';

/**
 * Identidade de uma mídia para cache e deduplicação de buscas.
 * Usa título + artista/canal "dobrados" (sem acento/caixa/pontuação), então pequenas
 * variações de escrita não geram buscas repetidas. Duração e estado de reprodução ficam de fora
 * de propósito: mudam sem que a mídia mude.
 */
export function mediaKey(media: Pick<MediaInfo, 'title' | 'artist' | 'channel'>): string {
  return `${fold(media.title)}|${fold(media.artist ?? media.channel ?? '')}`;
}

export function manualSearchUrl(query: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
}
