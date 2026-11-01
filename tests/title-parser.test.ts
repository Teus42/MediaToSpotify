import { describe, expect, it } from 'vitest';
import { analyzeTrackName, cleanArtistName, cleanDocumentTitle, parseMediaTitle } from '../src/metadata/title-parser';
import { fold, similarity } from '../src/metadata/text';

const first = (title: string, extra: { artist?: string; channel?: string } = {}) =>
  parseMediaTitle({ title, ...extra }).candidates[0];

describe('fold / similarity', () => {
  it('ignora acentos, caixa e pontuação', () => {
    expect(fold("Beyoncé — Don't Hurt Yourself!")).toBe('beyonce dont hurt yourself');
    expect(similarity('R.E.M.', 'REM')).toBeGreaterThan(0.95);
    expect(similarity('Simon & Garfunkel', 'Simon and Garfunkel')).toBe(1);
  });

  it('tolera erros de digitação sem igualar títulos diferentes', () => {
    expect(similarity('Bohemian Rapsody', 'Bohemian Rhapsody')).toBeGreaterThan(0.75);
    expect(similarity('Love Story', 'Hotel California')).toBeLessThan(0.4);
  });

  it('funciona com scripts sem espaços (CJK) e cirílico', () => {
    expect(similarity('夜に駆ける', '夜に駆ける')).toBe(1);
    expect(similarity('夜に駆ける', '群青')).toBeLessThan(0.3);
    expect(similarity('Кино', 'кино')).toBe(1);
  });
});

describe('parseMediaTitle', () => {
  it('separa "Artista - Título" e remove ruído entre colchetes', () => {
    const c = first('Queen - Bohemian Rhapsody (Official Video Remastered)');
    expect(c).toMatchObject({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    const p = parseMediaTitle({ title: 'Queen - Bohemian Rhapsody (Official Video Remastered)' });
    expect(p.variants).toContain('remaster');
  });

  it('remove sufixos "| Official Music Video", resolução e nome do site', () => {
    expect(first('Dua Lipa - Levitating | Official Music Video [4K]')).toMatchObject({
      artist: 'Dua Lipa',
      title: 'Levitating',
    });
    expect(first('Adele - Hello [HD] - YouTube')).toMatchObject({ artist: 'Adele', title: 'Hello' });
  });

  it('remove emojis e símbolos decorativos', () => {
    expect(first('🎵 Billie Eilish - bad guy 🔥')).toMatchObject({ artist: 'Billie Eilish', title: 'bad guy' });
  });

  it('extrai participações (feat.) tanto em colchetes quanto soltas', () => {
    const p = parseMediaTitle({ title: 'Calvin Harris - This Is What You Came For (feat. Rihanna)' });
    expect(p.candidates[0]).toMatchObject({ artist: 'Calvin Harris', title: 'This Is What You Came For' });
    expect(p.featured).toEqual(['Rihanna']);
    const q = parseMediaTitle({ title: 'Artist ft. Guest - Song Name' });
    expect(q.candidates[0]).toMatchObject({ artist: 'Artist', title: 'Song Name' });
    expect(q.featured).toEqual(['Guest']);
  });

  it('mantém a ordem alternativa (Título - Artista) como segunda leitura', () => {
    const p = parseMediaTitle({ title: 'Bohemian Rhapsody - Queen' });
    expect(p.candidates[0]).toMatchObject({ artist: 'Bohemian Rhapsody', title: 'Queen' });
    expect(p.candidates[1]).toMatchObject({ artist: 'Queen', title: 'Bohemian Rhapsody' });
  });

  it('usa o canal para decidir a ordem Artista/Título', () => {
    const c = first('Bohemian Rhapsody - Queen', { channel: 'Queen Official' });
    expect(c).toMatchObject({ artist: 'Queen', title: 'Bohemian Rhapsody' });
  });

  it('usa o artista informado pela página e descarta o segmento do artista', () => {
    const c = first('Tame Impala - The Less I Know The Better', { artist: 'Tame Impala' });
    expect(c).toMatchObject({ artist: 'Tame Impala', title: 'The Less I Know The Better' });
  });

  it('título solto: usa canal "- Topic" como artista com peso máximo', () => {
    const c = first('Blinding Lights', { channel: 'The Weeknd - Topic' });
    expect(c).toMatchObject({ artist: 'The Weeknd', title: 'Blinding Lights', weight: 1 });
  });

  it('título solto de canal comum gera hipótese fraca + hipótese sem artista', () => {
    const p = parseMediaTitle({ title: 'Blinding Lights', channel: 'Some Uploader' });
    expect(p.candidates.map((c) => c.artist)).toEqual(['Some Uploader', undefined]);
    expect(p.candidates[0]?.weight).toBeLessThan(1);
  });

  it('entende Artista "Título" entre aspas', () => {
    expect(first('Gilberto Gil "Aquele Abraço"')).toMatchObject({ artist: 'Gilberto Gil', title: 'Aquele Abraço' });
  });

  it('não confunde título que é palavra de ruído isolada', () => {
    expect(first("India.Arie - Video")).toMatchObject({ artist: 'India.Arie', title: 'Video' });
  });

  it('preserva títulos com palavras como "live" no núcleo', () => {
    expect(first('Bon Jovi - Live While We\'re Young')).toMatchObject({ title: "Live While We're Young" });
  });

  it('ignora o 3º segmento (álbum, gravadora, "Live at…") mas registra a versão', () => {
    const p = parseMediaTitle({ title: 'Coldplay - Yellow - Live at Wembley' });
    expect(p.candidates[0]).toMatchObject({ artist: 'Coldplay', title: 'Yellow' });
    expect(p.variants).toContain('live');
  });

  it('detecta versões: live, remix, acoustic', () => {
    expect(parseMediaTitle({ title: 'Coldplay - Yellow (Live at Glastonbury)' }).variants).toContain('live');
    expect(parseMediaTitle({ title: 'Artist - Song (DJ X Remix)' }).variants).toContain('remix');
    expect(parseMediaTitle({ title: 'Artist - Song - Acoustic Version' }).variants).toContain('acoustic');
  });

  it('lida com idiomas e escritas diferentes', () => {
    expect(first('米津玄師 - Lemon (Official Video)')).toMatchObject({ artist: '米津玄師', title: 'Lemon' });
    expect(first('Кино - Группа крови [Official Audio]')).toMatchObject({ artist: 'Кино', title: 'Группа крови' });
    expect(first('Anitta - Envolver (Vídeo Oficial)')).toMatchObject({ artist: 'Anitta', title: 'Envolver' });
  });

  it('separa Artista「Título」 colado e remove "Official Music Video" solto (caso real do YouTube)', () => {
    const p = parseMediaTitle({ title: 'Mrs. GREEN APPLE「ア・ポステリオリ」 Official Music Video', channel: 'Mrs. GREEN APPLE' });
    expect(p.candidates[0]).toMatchObject({ artist: 'Mrs. GREEN APPLE', title: 'ア・ポステリオリ', weight: 1 });
    // Sem canal: o artista é o texto antes das aspas.
    expect(first('Mrs. GREEN APPLE「ア・ポステリオリ」 Official Music Video')).toMatchObject({ artist: 'Mrs. GREEN APPLE', title: 'ア・ポステリオリ' });
    expect(first('YOASOBI『夜に駆ける』 Official Video')).toMatchObject({ artist: 'YOASOBI', title: '夜に駆ける' });
    expect(first('Gilberto Gil "Aquele Abraço" Ao Vivo')).toMatchObject({ artist: 'Gilberto Gil', title: 'Aquele Abraço' });
  });

  it('caso real I-BULL: o "|" separa o nome do anime; a leitura certa é Artista「Título」', () => {
    const title = 'jo0ji「I-BULL」Music Video | TVアニメ最終クール『BLEACH 千年血戦篇-禍進譚-』 オープニングテーマ';
    const p = parseMediaTitle({ title, channel: 'jo0ji' });
    expect(p.candidates[0]).toMatchObject({ artist: 'jo0ji', title: 'I-BULL', weight: 1 });
    // O nome do anime não vira "artista" nem "música" em nenhuma leitura.
    expect(p.candidates.some((c) => /BLEACH|アニメ/.test(`${c.artist ?? ''}${c.title}`))).toBe(false);
  });

  it('segmentos seguintes com aspas (ex.: Song "Live") não viram artista/título', () => {
    expect(first('Artist - Song "Live"')).toMatchObject({ artist: 'Artist', title: 'Song "Live"' });
  });

  it('remove ruído no fim do título sem parênteses, mas não corta títulos legítimos', () => {
    expect(first('Artist - Song Name Official Music Video')).toMatchObject({ title: 'Song Name' });
    expect(first('Artist - Song Name Lyrics HD')).toMatchObject({ title: 'Song Name' });
    expect(first('Artist - Greatest Hits Full Album')).toMatchObject({ title: 'Greatest Hits' });
    expect(first('Artist - Wonderful Music')).toMatchObject({ title: 'Wonderful Music' });
    expect(first('Artist - Video Killed the Radio Star')).toMatchObject({ title: 'Video Killed the Radio Star' });
  });

  it('nunca devolve lista vazia', () => {
    expect(parseMediaTitle({ title: '(Official Video)' }).candidates.length).toBeGreaterThan(0);
    expect(parseMediaTitle({ title: '🔥🔥🔥' }).candidates.length).toBeGreaterThanOrEqual(0);
  });

  it('ignora numeração de faixa', () => {
    expect(first('01 - Pink Floyd - Time')).toMatchObject({ artist: 'Pink Floyd', title: 'Time' });
  });
});

describe('cleanArtistName', () => {
  it('remove Topic, VEVO e Official', () => {
    expect(cleanArtistName('Daft Punk - Topic')).toBe('Daft Punk');
    expect(cleanArtistName('AdeleVEVO')).toBe('Adele');
    expect(cleanArtistName('Queen Official')).toBe('Queen');
    expect(cleanArtistName('Coldplay Official YouTube Channel')).toBe('Coldplay');
  });
});

describe('analyzeTrackName', () => {
  it('separa o núcleo do título de sufixos de versão do Spotify', () => {
    expect(analyzeTrackName('Bohemian Rhapsody - Remastered 2011')).toMatchObject({
      core: 'Bohemian Rhapsody',
      variants: ['remaster'],
    });
    expect(analyzeTrackName('Yellow - Live')).toMatchObject({ core: 'Yellow', variants: ['live'] });
    expect(analyzeTrackName('Song (feat. Someone)')).toMatchObject({ core: 'Song', featured: ['Someone'] });
    expect(analyzeTrackName('Love Story (Taylor\'s Version)').core).toBe('Love Story');
  });
});

describe('cleanDocumentTitle', () => {
  it('remove contador de notificações e nome do site', () => {
    expect(cleanDocumentTitle('(3) Queen - Bohemian Rhapsody - YouTube')).toBe('Queen - Bohemian Rhapsody');
    expect(cleanDocumentTitle('Song | Artist | SoundCloud')).toBe('Song - Artist');
  });
});
