// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { extractMetadata } from '../src/content/extract';

function loc(host: string, path = '/', search = '') {
  return { hostname: host, pathname: path, search, href: `https://${host}${path}${search}` };
}

const YT_WATCH = `
  <ytd-watch-flexy video-id="abc123"></ytd-watch-flexy>
  <div id="movie_player" class="html5-video-player"></div>
  <ytd-watch-metadata>
    <h1 class="ytd-watch-metadata"><yt-formatted-string>Queen - Bohemian Rhapsody (Official Video Remastered)</yt-formatted-string></h1>
    <div id="owner"><ytd-channel-name id="channel-name"><a href="/@Queen">Queen Official</a></ytd-channel-name></div>
  </ytd-watch-metadata>`;

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('extractMetadata — YouTube', () => {
  it('lê título e canal do DOM da página de vídeo (fonte "site")', () => {
    document.body.innerHTML = YT_WATCH;
    const r = extractMetadata({ doc: document, loc: loc('www.youtube.com', '/watch', '?v=abc123') });
    expect(r).toMatchObject({
      kind: 'media',
      source: 'site',
      meta: { title: 'Queen - Bohemian Rhapsody (Official Video Remastered)', channel: 'Queen Official' },
    });
  });

  it('trata o "artista" da Media Session como canal (não como artista)', () => {
    document.body.innerHTML = YT_WATCH.replace('<a href="/@Queen">Queen Official</a>', '');
    const r = extractMetadata({
      doc: document,
      loc: loc('www.youtube.com', '/watch', '?v=abc123'),
      mediaSession: {
        metadata: { title: 'Queen - Bohemian Rhapsody (Official Video Remastered)', artist: 'Queen Official', album: '', artwork: [] } as MediaMetadata,
      },
    });
    expect(r.kind).toBe('media');
    if (r.kind === 'media') {
      expect(r.meta.artist).toBeUndefined();
      expect(r.meta.channel).toBe('Queen Official');
    }
  });

  it('ignora o instante em que um anúncio está tocando', () => {
    document.body.innerHTML = YT_WATCH.replace('class="html5-video-player"', 'class="html5-video-player ad-showing"');
    expect(extractMetadata({ doc: document, loc: loc('www.youtube.com', '/watch', '?v=abc123') })).toEqual({ kind: 'hold' });
  });

  it('ignora o DOM do vídeo anterior durante a navegação (video-id ≠ v=)', () => {
    document.body.innerHTML = YT_WATCH;
    expect(extractMetadata({ doc: document, loc: loc('www.youtube.com', '/watch', '?v=OUTRO') })).toEqual({ kind: 'hold' });
  });

  it('fora de /watch (home, pré-visualizações) não há mídia relevante', () => {
    document.body.innerHTML = YT_WATCH;
    expect(extractMetadata({ doc: document, loc: loc('www.youtube.com', '/', '') })).toEqual({ kind: 'none' });
  });

  it('cai para o título da aba quando os seletores falham', () => {
    document.title = '(2) Artist - Song - YouTube';
    const r = extractMetadata({ doc: document, loc: loc('www.youtube.com', '/watch', '?v=x') });
    expect(r).toMatchObject({ kind: 'media', source: 'document', meta: { title: 'Artist - Song' } });
  });
});

describe('extractMetadata — YouTube Music', () => {
  it('lê título, artista e álbum da barra do player', () => {
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <yt-formatted-string class="title">Blinding Lights</yt-formatted-string>
        <yt-formatted-string class="byline">
          <a href="channel/UC1">The Weeknd</a> • <a href="browse/MPREb_1">After Hours</a> • 2020
        </yt-formatted-string>
      </ytmusic-player-bar>`;
    const r = extractMetadata({ doc: document, loc: loc('music.youtube.com', '/watch', '?v=1') });
    expect(r).toMatchObject({
      kind: 'media',
      source: 'site',
      meta: { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours' },
    });
  });

  it('sem links, usa a linha "Artista • Álbum • Ano"', () => {
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <yt-formatted-string class="title">Song</yt-formatted-string>
        <yt-formatted-string class="byline">Some Artist • Some Album • 2019</yt-formatted-string>
      </ytmusic-player-bar>`;
    const r = extractMetadata({ doc: document, loc: loc('music.youtube.com', '/watch', '?v=1') });
    expect(r).toMatchObject({ meta: { artist: 'Some Artist', album: 'Some Album' } });
  });
});

describe('extractMetadata — genérico', () => {
  it('usa a Media Session quando o site não tem adaptador (prioridade 2)', () => {
    document.title = 'Qualquer coisa';
    const r = extractMetadata({
      doc: document,
      loc: loc('example.com'),
      mediaSession: { metadata: { title: 'Track', artist: 'Band', album: 'LP', artwork: [{ src: 'https://x/y.jpg' }] } as MediaMetadata },
    });
    expect(r).toMatchObject({
      kind: 'media',
      source: 'mediasession',
      meta: { title: 'Track', artist: 'Band', album: 'LP', artworkUrl: 'https://x/y.jpg' },
    });
  });

  it('usa o título do elemento antes do título da aba (prioridade 3)', () => {
    document.title = 'Aba';
    const el = document.createElement('audio');
    el.setAttribute('title', 'Título do player');
    const r = extractMetadata({ doc: document, loc: loc('example.com'), element: el });
    expect(r).toMatchObject({ source: 'element', meta: { title: 'Título do player' } });
  });

  it('usa o título da aba como último recurso (prioridade 4)', () => {
    document.title = 'Podcast Ep. 12 | Example';
    const r = extractMetadata({ doc: document, loc: loc('example.com') });
    expect(r).toMatchObject({ source: 'document', meta: { title: 'Podcast Ep. 12 - Example' } });
  });

  it('sem nenhum título, não há mídia identificável', () => {
    expect(extractMetadata({ doc: document, loc: loc('example.com') })).toEqual({ kind: 'none' });
  });

  it('SoundCloud: lê a barra de reprodução', () => {
    document.body.innerHTML = `
      <div class="playbackSoundBadge">
        <a class="playbackSoundBadge__titleLink" title="Great Track"><span>Great Track</span></a>
        <a class="playbackSoundBadge__lightLink">Some DJ</a>
      </div>`;
    const r = extractMetadata({ doc: document, loc: loc('soundcloud.com', '/x/y') });
    expect(r).toMatchObject({ source: 'site', meta: { title: 'Great Track', artist: 'Some DJ' } });
  });
});
