import { text, type AdapterResult, type SiteAdapter } from './types';

/**
 * YouTube (www.youtube.com). Lê o título e o canal do DOM da página de vídeo.
 * Os seletores dependem do HTML do YouTube e podem mudar; quando falham, o extrator cai para
 * a Media Session e para o título da aba, então a extensão degrada em vez de quebrar.
 */
export const youtubeAdapter: SiteAdapter = {
  id: 'youtube',
  mediaSessionArtistIsChannel: true,
  matches: (host) => host === 'www.youtube.com' || host === 'm.youtube.com',

  read(doc, loc): AdapterResult {
    const onWatch = loc.pathname === '/watch';
    const onShorts = loc.pathname.startsWith('/shorts/');
    // Fora de /watch e /shorts, os <video> são pré-visualizações ao passar o mouse.
    if (!onWatch && !onShorts) return 'none';

    // Anúncio no player: o <video> toca o anúncio, mas o DOM ainda mostra o vídeo principal.
    if (doc.querySelector('.html5-video-player.ad-showing')) return 'hold';

    if (onShorts) return null; // Media Session / título da aba

    // DOM ainda do vídeo anterior (navegação SPA em andamento).
    const urlId = new URLSearchParams(loc.search).get('v');
    const domId = doc.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
    if (urlId && domId && urlId !== domId) return 'hold';

    const title =
      text(doc.querySelector('ytd-watch-metadata h1 yt-formatted-string')) ??
      text(doc.querySelector('h1.ytd-watch-metadata')) ??
      text(doc.querySelector('#above-the-fold #title h1'));
    if (!title) return null;

    const channel =
      text(doc.querySelector('ytd-watch-metadata ytd-channel-name#channel-name a')) ??
      text(doc.querySelector('#owner #channel-name a')) ??
      text(doc.querySelector('ytd-video-owner-renderer #channel-name a'));

    return channel ? { title, channel } : { title };
  },
};
