/**
 * Extração de metadados da mídia, na ordem de prioridade do projeto:
 *  1. metadados de reprodução da própria página (adaptadores de site, lidos do player);
 *  2. Media Session API;
 *  3. título fornecido pela plataforma no elemento <video>/<audio>;
 *  4. título da aba.
 *
 * Nada aqui captura áudio nem varre o conteúdo da página: só lemos o player e os metadados
 * que o próprio site já expõe.
 */

import { cleanDocumentTitle } from '../metadata/title-parser';
import { similarity } from '../metadata/text';
import type { TitleSource } from '../shared/types';
import { adapterFor } from './adapters';
import type { RawMeta } from './adapters';

/** O que o detector precisa de um elemento de mídia (real, ou espelho de um elemento fora do DOM). */
export type MediaLike = Pick<HTMLMediaElement, 'paused' | 'ended' | 'readyState' | 'duration' | 'loop' | 'muted' | 'volume' | 'tagName' | 'title' | 'isConnected'> & {
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
};

export interface ExtractContext {
  doc: Document;
  loc: Pick<Location, 'hostname' | 'pathname' | 'search' | 'href'>;
  mediaSession?: Pick<MediaSession, 'metadata'> | null;
  element?: MediaLike | null;
}

export type ExtractResult =
  | { kind: 'media'; meta: RawMeta & { title: string }; source: TitleSource }
  | { kind: 'none' }
  | { kind: 'hold' };

const MAX_LEN = 300;

function clean(s: string | undefined | null): string | undefined {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, MAX_LEN) : undefined;
}

function readMediaSession(ms: ExtractContext['mediaSession']): RawMeta | null {
  const md = ms?.metadata;
  const title = clean(md?.title);
  if (!md || !title) return null;
  const art = md.artwork?.[md.artwork.length - 1]?.src;
  const meta: RawMeta = { title };
  const artist = clean(md.artist);
  const album = clean(md.album);
  if (artist) meta.artist = artist;
  if (album) meta.album = album;
  if (art) meta.artworkUrl = art;
  return meta;
}

export function extractMetadata(ctx: ExtractContext): ExtractResult {
  const adapter = adapterFor(ctx.loc.hostname);
  const fromSite = adapter?.read(ctx.doc, ctx.loc) ?? null;
  if (fromSite === 'none') return { kind: 'none' };
  if (fromSite === 'hold') return { kind: 'hold' };

  const session = readMediaSession(ctx.mediaSession);

  if (fromSite?.title) {
    const meta: RawMeta & { title: string } = { ...fromSite, title: clean(fromSite.title) as string };
    // Completa com a Media Session quando ela descreve o mesmo conteúdo.
    if (session && similarity(session.title as string, meta.title) >= 0.9) {
      if (adapter?.mediaSessionArtistIsChannel) {
        if (!meta.channel && session.artist) meta.channel = session.artist;
      } else if (!meta.artist && session.artist) {
        meta.artist = session.artist;
      }
      if (!meta.album && session.album) meta.album = session.album;
      if (!meta.artworkUrl && session.artworkUrl) meta.artworkUrl = session.artworkUrl;
    }
    return { kind: 'media', meta, source: 'site' };
  }

  if (session?.title) {
    const meta = { ...session } as RawMeta & { title: string };
    if (adapter?.mediaSessionArtistIsChannel && meta.artist) {
      meta.channel = meta.artist;
      delete meta.artist;
    }
    return { kind: 'media', meta, source: 'mediasession' };
  }

  const el = ctx.element;
  const elementTitle = clean(el?.title) ?? clean(el?.getAttribute('aria-label')) ?? clean(el?.getAttribute('data-title'));
  if (elementTitle) return { kind: 'media', meta: { title: elementTitle }, source: 'element' };

  const docTitle = clean(cleanDocumentTitle(ctx.doc.title ?? ''));
  if (docTitle) return { kind: 'media', meta: { title: docTitle }, source: 'document' };

  return { kind: 'none' };
}
