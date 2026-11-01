import { text, type AdapterResult, type SiteAdapter } from './types';

/** SoundCloud: a barra de reprodução fixa no rodapé traz título e artista. */
export const soundcloudAdapter: SiteAdapter = {
  id: 'soundcloud',
  matches: (host) => host === 'soundcloud.com',

  read(doc): AdapterResult {
    const badge = doc.querySelector('.playbackSoundBadge');
    if (!badge) return null;
    const titleLink = badge.querySelector('.playbackSoundBadge__titleLink');
    const title = titleLink?.getAttribute('title')?.trim() || text(titleLink);
    if (!title) return null;
    const artist = text(badge.querySelector('.playbackSoundBadge__lightLink'));
    return artist ? { title, artist } : { title };
  },
};
