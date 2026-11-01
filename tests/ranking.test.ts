import { describe, expect, it } from 'vitest';
import { rankTracks } from '../src/matching/ranking';
import { buildQueries } from '../src/matching/queries';
import { parseMediaTitle } from '../src/metadata/title-parser';
import type { SpotifyTrack } from '../src/shared/types';

let seq = 0;
function track(over: Partial<SpotifyTrack> & { name: string; artists: string[] }): SpotifyTrack {
  seq++;
  return {
    id: `id${seq}`,
    uri: `spotify:track:id${seq}`,
    album: 'Album',
    albumType: 'album',
    durationMs: 200_000,
    url: `https://open.spotify.com/track/id${seq}`,
    ...over,
  };
}

describe('rankTracks', () => {
  it('escolhe a gravação original com confiança alta e rebaixa versões ao vivo/karaokê', () => {
    const parsed = parseMediaTitle({ title: 'Queen - Bohemian Rhapsody (Official Video Remastered)' });
    const results = rankTracks(
      [
        track({ name: 'Bohemian Rhapsody - Live Aid', artists: ['Queen'], durationMs: 130_000 }),
        track({ name: 'Bohemian Rhapsody - Karaoke Version', artists: ['Karaoke Hits'], album: 'Karaoke Rock' }),
        track({ name: 'Bohemian Rhapsody - Remastered 2011', artists: ['Queen'], durationMs: 354_000, album: 'Greatest Hits' }),
      ],
      parsed,
      { durationSec: 355 },
    );
    expect(results[0]?.track.name).toBe('Bohemian Rhapsody - Remastered 2011');
    expect(results[0]?.confidence).toBe('high');
    expect(results.find((r) => r.track.artists[0] === 'Karaoke Hits')).toBeUndefined();
  });

  it('colapsa a mesma gravação publicada em vários álbuns', () => {
    const parsed = parseMediaTitle({ title: 'Adele - Hello' });
    const results = rankTracks(
      [
        track({ name: 'Hello', artists: ['Adele'], album: '25', durationMs: 295_000 }),
        track({ name: 'Hello', artists: ['Adele'], album: 'Now 93', albumType: 'compilation', durationMs: 295_000 }),
      ],
      parsed,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.track.album).toBe('25');
  });

  it('mesmo título com artista diferente nunca passa de "pouco provável"', () => {
    const parsed = parseMediaTitle({ title: 'Nirvana - Come As You Are' });
    const results = rankTracks([track({ name: 'Come As You Are', artists: ['Peter Wolf'] })], parsed);
    expect(results.map((r) => r.confidence)).toEqual(['weak']);
  });

  it('palpites fracos só aparecem quando não há nada melhor', () => {
    const parsed = parseMediaTitle({ title: 'Nirvana - Come As You Are' });
    const results = rankTracks(
      [track({ name: 'Come As You Are', artists: ['Peter Wolf'] }), track({ name: 'Come As You Are', artists: ['Nirvana'], durationMs: 219_000 })],
      parsed,
      { durationSec: 219 },
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.track.artists[0]).toBe('Nirvana');
  });

  it('retorna vazio quando nada se parece', () => {
    const parsed = parseMediaTitle({ title: 'Banda Obscura - Musica Inexistente' });
    const results = rankTracks(
      [track({ name: 'Hotel California', artists: ['Eagles'] }), track({ name: 'Yesterday', artists: ['The Beatles'] })],
      parsed,
    );
    expect(results).toEqual([]);
  });

  it('tolera erro de digitação no título', () => {
    const parsed = parseMediaTitle({ title: 'Queen - Bohemian Rapsody' });
    const results = rankTracks([track({ name: 'Bohemian Rhapsody', artists: ['Queen'] })], parsed);
    expect(results[0]?.confidence).not.toBe('low');
  });

  it('usa a duração para desempatar versões equivalentes', () => {
    const parsed = parseMediaTitle({ title: 'Artist - Song' });
    const results = rankTracks(
      [
        track({ name: 'Song', artists: ['Artist'], album: 'A', durationMs: 260_000 }),
        track({ name: 'Song', artists: ['Artist'], album: 'B', durationMs: 215_000 }),
      ],
      parsed,
      { durationSec: 214 },
    );
    expect(results[0]?.track.album).toBe('B');
  });

  it('penaliza versão ao vivo quando a mídia não é ao vivo, e vice-versa', () => {
    const studio = rankTracks(
      [
        track({ name: 'Yellow - Live', artists: ['Coldplay'] }),
        track({ name: 'Yellow', artists: ['Coldplay'] }),
      ],
      parseMediaTitle({ title: 'Coldplay - Yellow' }),
    );
    expect(studio[0]?.track.name).toBe('Yellow');

    const live = rankTracks(
      [
        track({ name: 'Yellow', artists: ['Coldplay'] }),
        track({ name: 'Yellow - Live', artists: ['Coldplay'] }),
      ],
      parseMediaTitle({ title: 'Coldplay - Yellow (Live)' }),
    );
    expect(live[0]?.track.name).toBe('Yellow - Live');
  });

  it('título solto sem artista conhecido nunca passa de confiança baixa', () => {
    const parsed = parseMediaTitle({ title: 'Blinding Lights', channel: 'Some Uploader' });
    const results = rankTracks([track({ name: 'Blinding Lights', artists: ['The Weeknd'] })], parsed);
    expect(results[0]?.confidence).toBe('low');
  });

  it('título solto + canal "- Topic" identifica o artista', () => {
    const parsed = parseMediaTitle({ title: 'Blinding Lights', channel: 'The Weeknd - Topic' });
    const results = rankTracks([track({ name: 'Blinding Lights', artists: ['The Weeknd'] })], parsed);
    expect(results[0]?.confidence).toBe('high');
  });

  it('rebaixa faixas indisponíveis na região', () => {
    const parsed = parseMediaTitle({ title: 'Artist - Song' });
    const results = rankTracks(
      [
        track({ name: 'Song', artists: ['Artist'], album: 'Blocked', isPlayable: false }),
        track({ name: 'Song', artists: ['Artist'], album: 'Ok', isPlayable: true, durationMs: 230_000 }),
      ],
      parsed,
    );
    expect(results[0]?.track.album).toBe('Ok');
  });

  it('aceita artista vindo da página (Media Session) com título "sujo"', () => {
    const parsed = parseMediaTitle({ title: 'Levitating (Official Lyric Video)', artist: 'Dua Lipa - Topic' });
    const results = rankTracks([track({ name: 'Levitating', artists: ['Dua Lipa'] })], parsed);
    expect(results[0]?.confidence).toBe('high');
  });
});

describe('caso real: Mrs. GREEN APPLE「ア・ポステリオリ」', () => {
  const media = { title: 'Mrs. GREEN APPLE「ア・ポステリオリ」 Official Music Video', channel: 'Mrs. GREEN APPLE' };

  it('a 1ª consulta usa título e artista já separados, e a última é o texto inteiro', () => {
    const qs = buildQueries(parseMediaTitle(media));
    expect(qs[0]).toBe('track:"ア・ポステリオリ" artist:"Mrs. GREEN APPLE"');
    expect(qs.at(-1)).toBe('Mrs. GREEN APPLE「ア・ポステリオリ」 Official Music Video');
  });

  it('a faixa do Spotify é aceita com confiança alta', () => {
    const results = rankTracks([track({ name: 'ア・ポステリオリ', artists: ['Mrs. GREEN APPLE'], durationMs: 240_000 })], parseMediaTitle(media), { durationSec: 241 });
    expect(results[0]?.confidence).toBe('high');
  });
});

describe('caso real: jo0ji「I-BULL」 (nome do anime após "|")', () => {
  const media = { title: 'jo0ji「I-BULL」Music Video | TVアニメ最終クール『BLEACH 千年血戦篇-禍進譚-』 オープニングテーマ', channel: 'jo0ji' };

  it('a 1ª consulta já usa artista e música corretos', () => {
    expect(buildQueries(parseMediaTitle(media))[0]).toBe('track:"I-BULL" artist:"jo0ji"');
  });

  it('aceita "I-BULL - iburu" e prefere a versão cheia à "Anime size" pela duração', () => {
    const results = rankTracks(
      [
        track({ name: 'I-BULL - iburu - Anime size', artists: ['jo0ji'], durationMs: 91_000 }),
        track({ name: 'I-BULL - iburu', artists: ['jo0ji'], durationMs: 240_000 }),
        track({ name: 'BLEACH TYBW theme', artists: ['Shiro SAGISU'], durationMs: 279_000 }),
      ],
      parseMediaTitle(media),
      { durationSec: 241 },
    );
    expect(results[0]?.track.name).toBe('I-BULL - iburu');
    expect(results[0]?.confidence).toBe('high');
    expect(results.some((r) => r.track.artists[0] === 'Shiro SAGISU')).toBe(false);
  });
});

describe('caso real: 【Ado】好きでいて (Suki de Ite)', () => {
  const media = { title: '【Ado】好きでいて (Suki de Ite)', channel: 'Ado' };

  it('o texto entre parênteses vira apelido do título e 【Ado】 é lido como artista', () => {
    const p = parseMediaTitle(media);
    expect(p.aliases).toEqual(['Suki de Ite']);
    expect(p.candidates[0]).toMatchObject({ artist: 'Ado', title: '好きでいて', weight: 1 });
    expect(p.candidates.some((c) => c.title === 'Suki de Ite' && c.artist === 'Ado')).toBe(true);
  });

  it('sem canal informado, o artista vem de 【Ado】', () => {
    expect(parseMediaTitle({ title: '【Ado】好きでいて (Suki de Ite)' }).candidates[0]).toMatchObject({ artist: 'Ado', title: '好きでいて' });
  });

  it('a faixa "Suki de Ite" do Spotify é aceita com confiança alta (antes: 0,28)', () => {
    const results = rankTracks(
      [
        track({ name: '好きでいてくれていいよ', artists: ['すとぷり'], durationMs: 225_000 }),
        track({ name: 'Suki de Ite', artists: ['Ado'], durationMs: 245_000 }),
        track({ name: 'AiAiA', artists: ['Ado'], durationMs: 254_000 }),
      ],
      parseMediaTitle(media),
      { durationSec: 245 },
    );
    expect(results[0]?.track.name).toBe('Suki de Ite');
    expect(results[0]?.confidence).toBe('high');
  });

  it('as consultas incluem o apelido com filtros de campo logo no começo', () => {
    const qs = buildQueries(parseMediaTitle(media));
    expect(qs[0]).toBe('track:"好きでいて" artist:"Ado"');
    expect(qs[1]).toBe('track:"Suki de Ite" artist:"Ado"');
    expect(qs.at(-1)).toBe('【Ado】好きでいて (Suki de Ite)');
  });

  it('não confunde ruído e metadados comuns entre parênteses com nome da música', () => {
    for (const t of [
      'Artist - Song (Official Video)',
      'Artist - Song (Live at Wembley)',
      'Artist - Song (2011)',
      'Artist - Song (TV Size)',
      'Artist - Song (Prod. by Someone)',
      "Artist - Song (Taylor's Version)",
      'Artist - Song (feat. Guest)',
      'Artist - Song (Artist)',
    ]) {
      expect(parseMediaTitle({ title: t }).aliases, t).toEqual([]);
    }
  });
});

describe('resposta sem lista de artistas', () => {
  it('não derruba uma faixa de título idêntico só porque o campo `artists` veio vazio', () => {
    const parsed = parseMediaTitle({ title: 'Mrs. GREEN APPLE「ア・ポステリオリ」 Official Music Video', channel: 'Mrs. GREEN APPLE' });
    const results = rankTracks([track({ name: 'ア・ポステリオリ', artists: [] })], parsed);
    expect(results).toHaveLength(1);
  });
});

describe('buildQueries', () => {
  it('começa pela consulta com filtros de campo e limita a 4 consultas', () => {
    const qs = buildQueries(parseMediaTitle({ title: 'Queen - Bohemian Rhapsody' }));
    expect(qs[0]).toBe('track:"Bohemian Rhapsody" artist:"Queen"');
    expect(qs.length).toBeLessThanOrEqual(4);
    expect(new Set(qs).size).toBe(qs.length);
  });

  it('sem artista, pesquisa só pelo título', () => {
    const qs = buildQueries(parseMediaTitle({ title: 'Some Song' }));
    expect(qs).toEqual(['Some Song']);
  });

  it('remove aspas do texto para não quebrar a sintaxe da busca', () => {
    const qs = buildQueries(parseMediaTitle({ title: 'A "B" - C' }));
    for (const q of qs) expect((q.match(/"/g) ?? []).length % 2).toBe(0);
    expect(qs.join(' ')).not.toContain('\\"');
  });
});
