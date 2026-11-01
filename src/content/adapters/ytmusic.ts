import { text, type AdapterResult, type SiteAdapter } from './types';

/**
 * YouTube Music. A barra do player mostra título e uma linha "Artista • Álbum • Ano"
 * (ou "Artista • 12 mi de visualizações • 2 anos" para vídeos). Os links dentro da linha
 * distinguem artistas (…/channel/…) de álbuns (…/browse/…).
 */
export const ytMusicAdapter: SiteAdapter = {
  id: 'ytmusic',
  matches: (host) => host === 'music.youtube.com',

  read(doc): AdapterResult {
    const bar = doc.querySelector('ytmusic-player-bar');
    if (!bar) return null;
    const title = text(bar.querySelector('yt-formatted-string.title'));
    if (!title) return null;

    const byline = bar.querySelector('yt-formatted-string.byline');
    const meta: { title: string; artist?: string; album?: string } = { title };

    const artistLinks = Array.from(byline?.querySelectorAll('a[href*="channel/"]') ?? [])
      .map((a) => text(a))
      .filter((s): s is string => !!s);
    const albumLink = text(byline?.querySelector('a[href*="browse/"]'));

    if (artistLinks.length > 0) {
      meta.artist = artistLinks.join(', ');
      if (albumLink) meta.album = albumLink;
    } else {
      const parts = (text(byline) ?? '').split(' • ').map((p) => p.trim()).filter(Boolean);
      if (parts[0]) meta.artist = parts[0];
      if (parts.length === 3 && /^\d{4}$/.test(parts[2] as string)) meta.album = parts[1];
    }
    return meta;
  },
};
