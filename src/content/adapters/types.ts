/** Metadados crus lidos da página, antes de virarem MediaInfo. */
export interface RawMeta {
  title?: string;
  artist?: string;
  album?: string;
  channel?: string;
  artworkUrl?: string;
}

/**
 * Resultado de um adaptador de site:
 *  - `null`: o adaptador não tem opinião (usa-se Media Session / elemento / título da aba);
 *  - `'none'`: a página atual não tem mídia relevante (ex.: home do YouTube com pré-visualizações);
 *  - `'hold'`: estado transitório (anúncio, DOM ainda do vídeo anterior) — ignore este instante;
 *  - `RawMeta`: metadados lidos do DOM do player.
 */
export type AdapterResult = RawMeta | 'none' | 'hold' | null;

export interface SiteAdapter {
  id: string;
  matches(host: string): boolean;
  read(doc: Document, loc: Pick<Location, 'pathname' | 'search' | 'href'>): AdapterResult;
  /** Em alguns sites o "artist" da Media Session é o canal que publicou, não o artista. */
  mediaSessionArtistIsChannel?: boolean;
}

export function text(el: Element | null | undefined): string | undefined {
  const t = el?.textContent?.replace(/\s+/g, ' ').trim();
  return t ? t : undefined;
}
