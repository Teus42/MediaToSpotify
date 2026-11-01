// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../src/popup/views';
import { initialState, type Actions, type State } from '../src/popup/state';
import { describeError, formatDuration } from '../src/popup/format';
import type { Snapshot } from '../src/shared/messages';
import type { MediaInfo, ScoredMatch, SearchOutcome } from '../src/shared/types';

const media: MediaInfo = {
  title: '<img src=x onerror=alert(1)> Queen - Bohemian Rhapsody',
  artist: 'Queen',
  host: 'www.youtube.com',
  playback: 'playing',
  source: 'site',
  updatedAt: 1,
};

const match = (name: string, confidence: ScoredMatch['confidence'] = 'high', extra = {}): ScoredMatch => ({
  score: 0.9,
  confidence,
  track: { id: name, uri: `spotify:track:${name}`, name, artists: ['Queen'], album: 'A Night at the Opera', durationMs: 355_000, url: `https://open.spotify.com/track/${name}`, ...extra },
});

const outcome = (matches: ScoredMatch[]): SearchOutcome => ({ status: matches.length ? 'found' : 'not-found', matches, queries: [], searchedAt: 1 });

function stateWith(snapshot: Omit<Partial<Snapshot>, 'auth'> & { auth?: Partial<Snapshot['auth']> }, patch: Partial<State> = {}): State {
  const s = initialState();
  s.loaded = true;
  s.snapshot = {
    tabId: 1,
    media,
    search: { phase: 'idle', manualSearchUrl: 'https://open.spotify.com/search/x' },
    ...snapshot,
    auth: { configured: true, connected: true, ...(snapshot.auth ?? {}) },
  } as Snapshot;
  return Object.assign(s, patch);
}

const noop = new Proxy({}, { get: () => () => undefined }) as Actions;
const text = (state: State, actions: Actions = noop) => renderApp(state, actions).textContent ?? '';
const render = (state: State, actions: Actions = noop) => renderApp(state, actions);

describe('estados do popup', () => {
  it('nenhuma mídia em reprodução', () => {
    const s = initialState();
    s.loaded = true;
    s.snapshot = { tabId: null, media: null, search: { phase: 'idle' }, auth: { configured: true, connected: true } };
    expect(text(s)).toContain('Nenhuma mídia em reprodução');
  });

  it('mídia identificada + pesquisa em andamento', () => {
    const t = text(stateWith({ search: { phase: 'searching' } }));
    expect(t).toContain('Pesquisando no Spotify');
    expect(t).toContain('Tocando');
    expect(render(stateWith({ search: { phase: 'searching' } })).querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('resultado encontrado: capa, música, artista, álbum, duração e os dois botões', () => {
    const el = render(stateWith({ search: { phase: 'done', outcome: outcome([match('t1')]) } }));
    const t = el.textContent ?? '';
    expect(t).toContain('Pesquisa concluída');
    expect(t).toContain('t1');
    expect(t).toContain('A Night at the Opera · 5:55');
    expect(t).toContain('Ouvir no Spotify');
    expect(t).toContain('Adicionar à playlist');
    expect(t).toContain('Correspondência provável');
  });

  it('confiança baixa pede confirmação; faixa indisponível é sinalizada', () => {
    const t = text(stateWith({ search: { phase: 'done', outcome: outcome([match('x', 'low', { isPlayable: false })]) } }));
    expect(t).toContain('confirme');
    expect(t).toContain('Indisponível na sua região');
  });

  it('palpite "pouco provável": rótulo claro, botões presentes e detalhes técnicos visíveis', () => {
    const out = outcome([match('Suki de Ite', 'weak')]);
    out.debug = { queries: [{ q: 'x', returned: 10 }], readings: [{ artist: 'Ado', title: '好きでいて' }], top: [{ name: 'Suki de Ite', artists: ['Ado'], durationMs: 245_000, score: 0.28 }] };
    const el = render(stateWith({ search: { phase: 'done', outcome: out } }));
    const t = el.textContent ?? '';
    expect(t).toContain('Pouco provável — confira com atenção');
    expect(t).toContain('Ouvir no Spotify');
    expect(t).toContain('Adicionar à playlist');
    expect(t).toContain('Detalhes técnicos');
    expect(el.querySelector('.confidence.weak')).not.toBeNull();
  });

  it('correspondência firme não mostra detalhes técnicos', () => {
    const el = render(stateWith({ search: { phase: 'done', outcome: outcome([match('t1', 'high')]) } }));
    expect(el.textContent).not.toContain('Detalhes técnicos');
  });

  it('alternativas aparecem e podem ser escolhidas', () => {
    const selectMatch = vi.fn();
    const el = render(stateWith({ search: { phase: 'done', outcome: outcome([match('a'), match('b')]) } }), { ...noop, selectMatch } as Actions);
    expect(el.textContent).toContain('Outras possibilidades (1)');
    (el.querySelectorAll('.alt')[1] as HTMLElement).click();
    expect(selectMatch).toHaveBeenCalledWith(1);
  });

  it('nenhum resultado: mensagem amigável + pesquisa manual', () => {
    const t = text(stateWith({ search: { phase: 'done', outcome: outcome([]), manualSearchUrl: 'https://open.spotify.com/search/x' } }));
    expect(t).toContain('Não encontramos essa faixa no Spotify');
    expect(t).toContain('Pesquisar manualmente no Spotify');
  });

  it('usuário não autenticado: oferece conectar e pesquisa manual', () => {
    const t = text(stateWith({ auth: { connected: false } }));
    expect(t).toContain('Conectar ao Spotify');
    expect(t).toContain('Pesquisar manualmente no Spotify');
  });

  it('app Spotify não configurado: leva às configurações', () => {
    const connect = vi.fn();
    const openSettings = vi.fn();
    const el = render(stateWith({ auth: { configured: false, connected: false } }), { ...noop, connect, openSettings } as Actions);
    expect(el.textContent).toContain('cadastre o Client ID');
    (Array.from(el.querySelectorAll('button')).find((b) => /Abrir configurações/.test(b.textContent ?? '')) as HTMLElement).click();
    expect(openSettings).toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('erros de conexão, limite e permissão têm texto compreensível e ação', () => {
    const net = text(stateWith({ search: { phase: 'error', error: { kind: 'network', message: 'x' } } }));
    expect(net).toContain('Sem conexão com o Spotify');
    expect(net).toContain('Tentar de novo');
    expect(text(stateWith({ search: { phase: 'error', error: { kind: 'rate-limit', message: 'x', retryAfterSec: 42 } } }))).toContain('42 s');
    const forbidden = describeError({ kind: 'forbidden', message: 'Insufficient client scope' });
    expect(forbidden.detail).toContain('Insufficient client scope');
    expect(forbidden.detail).toContain('User Management');
  });

  it('texto vindo da página nunca é interpretado como HTML', () => {
    const el = render(stateWith({ search: { phase: 'searching' } }));
    expect(el.querySelector('img[onerror]')).toBeNull();
    expect(el.querySelector('.media-title')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('aviso de que a abertura do app não pôde ser confirmada', () => {
    const s = stateWith({ search: { phase: 'done', outcome: outcome([match('t1')]) } }, { appOpenAttempted: true });
    expect(text(s)).toContain('Não conseguimos confirmar');
  });
});

describe('painel de playlists', () => {
  const base = () =>
    stateWith(
      { search: { phase: 'done', outcome: outcome([match('t1')]) } },
      {
        panel: 'playlists',
        playlists: {
          status: 'ready',
          filter: '',
          selectedIds: ['a'],
          touched: false,
          items: [
            { id: 'a', name: 'Favoritas', trackCount: 1, editable: true, collaborative: false },
            { id: 'b', name: 'Da Maria', trackCount: 10, editable: false, collaborative: false },
            { id: 'c', name: 'Coletiva', trackCount: 0, editable: true, collaborative: true },
          ],
        },
      },
    );
  const mainButton = (st: State) => Array.from(render(st).querySelectorAll<HTMLButtonElement>('.actions.single button'))[0] as HTMLButtonElement;

  it('lista com contagem (singular/plural), colaborativa e somente leitura desabilitada', () => {
    const el = render(base());
    const t = el.textContent ?? '';
    expect(t).toContain('1 faixa');
    expect(t).toContain('0 faixas · Colaborativa');
    expect(t).toContain('Somente leitura');
    const boxes = Array.from(el.querySelectorAll<HTMLInputElement>('input[name=playlist]'));
    expect(boxes.map((r) => r.disabled)).toEqual([false, true, false]);
    expect(boxes.map((r) => r.checked)).toEqual([true, false, false]);
    expect(t).toContain('Adicionar a “Favoritas”');
  });

  it('permite marcar várias playlists; o botão resume quantas e cada marca chama selectPlaylist', () => {
    const selectPlaylist = vi.fn();
    const s = base();
    s.playlists.selectedIds = ['a', 'c'];
    const el = render(s, { ...noop, selectPlaylist } as Actions);
    expect(el.textContent).toContain('Adicionar a 2 playlists');
    expect(el.textContent).toContain('Marque quantas playlists quiser');
    document.body.append(el); // jsdom só dispara `change` em checkbox conectado ao documento
    (el.querySelectorAll('input[name=playlist]')[2] as HTMLInputElement).click();
    expect(selectPlaylist).toHaveBeenCalledWith('c');
  });

  it('filtro ignora acentos e caixa', () => {
    const s = base();
    s.playlists.filter = 'COLÉTIVA';
    expect(render(s).querySelectorAll('.pl-row')).toHaveLength(1);
    s.playlists.filter = 'zzz';
    expect(text(s)).toContain('Nenhuma playlist com esse nome');
  });

  it('resultado por playlist: sucesso, duplicata (com "adicionar mesmo assim") e erro', () => {
    const ok = base();
    ok.add = { status: 'done', results: [{ playlistId: 'a', playlistName: 'Favoritas', status: 'added' }] };
    expect(text(ok)).toContain('Faixa adicionada!');
    expect(text(ok)).toContain('Salva em “Favoritas”.');

    const confirmAdd = vi.fn();
    const dup = base();
    dup.add = { status: 'done', results: [{ playlistId: 'a', playlistName: 'Favoritas', status: 'duplicate' }] };
    const el = render(dup, { ...noop, confirmAdd } as Actions);
    expect(el.textContent).toContain('Esta faixa já está na playlist');
    (Array.from(el.querySelectorAll('button')).find((b) => /mesmo assim/.test(b.textContent ?? '')) as HTMLElement).click();
    expect(confirmAdd).toHaveBeenCalledWith(true);

    const err = base();
    err.add = { status: 'done', results: [{ playlistId: 'a', playlistName: 'Favoritas', status: 'error', error: { kind: 'forbidden', message: 'Sem permissão' } }] };
    expect(text(err)).toContain('Não foi possível adicionar a “Favoritas”');
    expect(text(err)).toContain('O Spotify negou o acesso');
  });

  it('resultado misto em várias playlists aparece separado por situação', () => {
    const s = base();
    s.playlists.selectedIds = ['a', 'c'];
    s.add = {
      status: 'done',
      results: [
        { playlistId: 'a', playlistName: 'Favoritas', status: 'added' },
        { playlistId: 'c', playlistName: 'Coletiva', status: 'duplicate' },
      ],
    };
    const t = text(s);
    expect(t).toContain('Salva em “Favoritas”.');
    expect(t).toContain('“Coletiva” já contém essa música.');
  });

  it('o botão só conta o que ainda falta salvar e mostra "Adicionada" quando tudo foi salvo', () => {
    const s = base();
    s.playlists.selectedIds = ['a', 'c'];
    s.add = { status: 'done', results: [{ playlistId: 'a', playlistName: 'Favoritas', status: 'added' }] };
    expect(mainButton(s).textContent).toContain('Adicionar a “Coletiva”');
    expect(mainButton(s).disabled).toBe(false);

    s.add = { status: 'done', results: [{ playlistId: 'a', playlistName: 'Favoritas', status: 'added' }, { playlistId: 'c', playlistName: 'Coletiva', status: 'added' }] };
    expect(mainButton(s).textContent).toContain('Adicionada a 2 playlists');
    expect(mainButton(s).disabled).toBe(true);
  });

  it('botão de confirmar fica desabilitado sem seleção ou durante a operação', () => {
    const s = base();
    s.playlists.selectedIds = [];
    expect(mainButton(s).disabled).toBe(true);
    expect(mainButton(s).textContent).toContain('Escolha uma ou mais playlists');
    const adding = base();
    adding.add = { status: 'adding', results: [] };
    expect(mainButton(adding).disabled).toBe(true);
  });
});

describe('format', () => {
  it('formata duração', () => {
    expect(formatDuration(355_000)).toBe('5:55');
    expect(formatDuration(61_000)).toBe('1:01');
    expect(formatDuration(0)).toBe('');
  });
});

describe('detalhes técnicos de "não encontrado"', () => {
  it('lista consultas, contagem e candidatas com nota', () => {
    const out = outcome([]);
    out.debug = {
      market: 'BR',
      readings: [{ artist: 'Mrs. GREEN APPLE', title: 'ア・ポステリオリ' }],
      queries: [{ q: 'track:"ア・ポステリオリ" artist:"Mrs. GREEN APPLE"', returned: 0 }],
      top: [{ name: 'Outra', artists: ['X'], durationMs: 200_000, score: 0.31 }],
    };
    const el = render(stateWith({ search: { phase: 'done', outcome: out } }));
    const pre = el.querySelector('details.debug pre')?.textContent ?? '';
    expect(pre).toContain('Mercado: BR');
    expect(pre).toContain('(0 resultados)');
    expect(pre).toContain('0.31  Outra — X [3:20]');
  });
});
