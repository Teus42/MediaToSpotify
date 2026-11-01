import { fold } from '../metadata/text';
import type { PlaylistSummary, ScoredMatch, SearchOutcome } from '../shared/types';
import { h, icon, logo, put } from './dom';
import { CONFIDENCE_LABEL, PLAYBACK_LABEL, SOURCE_LABEL, describeError, formatDuration } from './format';
import type { Actions, AddResultItem, State } from './state';

const SUPPORTED_SITES = ['YouTube', 'YouTube Music', 'SoundCloud', 'Bandcamp', 'Deezer', 'TIDAL', 'Apple Music'];

function safeImg(url: string | undefined, className: string, alt = ''): HTMLElement {
  if (url && /^https:\/\//i.test(url)) {
    const img = h('img', { class: className, src: url, alt, loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(h('div', { class: `${className} placeholder` }, icon('note', 20))));
    return img;
  }
  return h('div', { class: `${className} placeholder` }, icon('note', 20));
}

function spinner(): HTMLElement {
  return h('span', { class: 'spinner', role: 'progressbar', 'aria-label': 'Carregando' });
}

/* ------------------------------------------------------------------ */

export function renderApp(state: State, a: Actions): HTMLElement {
  const root = h('div', { class: 'app' });
  put(root, renderHeader(state, a));

  if (state.fatal) {
    put(root, renderError(state.fatal, a, true));
    return root;
  }
  if (!state.loaded) {
    put(root, h('div', { class: 'card center muted' }, spinner(), h('span', {}, 'Carregando…')));
    return root;
  }

  if (state.connectError) put(root, renderError(state.connectError, a, false));
  put(root, renderMedia(state, a));
  put(root, renderResult(state, a));
  if (state.panel === 'playlists') put(root, renderPlaylistPanel(state, a));
  return root;
}

/* ---------------- cabeçalho ---------------- */

function renderHeader(state: State, a: Actions): HTMLElement {
  const auth = state.snapshot?.auth;
  let pill: HTMLElement;
  if (!state.loaded) {
    pill = h('span', { class: 'pill muted' }, '…');
  } else if (auth?.connected) {
    const name = auth.user?.displayName ?? auth.user?.id;
    pill = h('span', { class: 'pill ok', title: name ? `Conectado como ${name}` : 'Conectado ao Spotify' }, h('span', { class: 'dot' }), 'Conectado');
  } else if (auth && !auth.configured) {
    pill = h('button', { class: 'pill warn', onClick: a.openSettings, title: 'Informe o Client ID do seu app Spotify' }, 'Configurar');
  } else {
    pill = h(
      'button',
      { class: 'pill off', onClick: a.connect, disabled: state.connecting, title: 'Conectar à sua conta do Spotify' },
      state.connecting ? 'Conectando…' : 'Conectar',
    );
  }
  return h(
    'header',
    { class: 'header' },
    h('div', { class: 'brand' }, logo(26), h('h1', {}, 'Media to Spotify')),
    h('div', { class: 'header-actions' }, pill, h('button', { class: 'icon-btn', onClick: a.openSettings, 'aria-label': 'Configurações', title: 'Configurações' }, icon('gear'))),
  );
}

/* ---------------- erros ---------------- */

function renderError(err: NonNullable<State['connectError']>, a: Actions, fatal: boolean): HTMLElement {
  const view = describeError(err);
  const actions = h('div', { class: 'row gap' });
  if (view.actions.includes('connect')) put(actions, h('button', { class: 'btn small primary', onClick: a.connect }, 'Conectar'));
  if (view.actions.includes('retry') && !fatal) put(actions, h('button', { class: 'btn small', onClick: a.retrySearch }, 'Tentar de novo'));
  if (view.actions.includes('settings')) put(actions, h('button', { class: 'btn small', onClick: a.openSettings }, 'Configurações'));
  return h(
    'div',
    { class: 'banner error', role: 'alert' },
    icon('alert', 18),
    h('div', { class: 'banner-body' }, h('strong', {}, view.title), h('p', {}, view.detail), actions.childElementCount ? actions : null),
  );
}

/* ---------------- mídia atual ---------------- */

function renderMedia(state: State, a: Actions): HTMLElement {
  const snap = state.snapshot;
  const media = snap?.media;
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-media' }, h('h2', { id: 'h-media', class: 'card-label' }, 'Mídia atual'));

  if (!media) {
    put(card, 
      h(
        'div',
        { class: 'empty' },
        h('div', { class: 'empty-icon' }, icon('note', 28)),
        h('strong', {}, 'Nenhuma mídia em reprodução'),
        h('p', { class: 'muted' }, `Toque um vídeo ou uma música em ${SUPPORTED_SITES.join(', ')} e a extensão identifica o título e procura no Spotify.`),
        renderSiteAccess(state, a),
      ),
    );
    return card;
  }

  const sub = [media.artist ?? media.channel, media.album, media.host].filter(Boolean).join(' · ');
  const phase = snap?.search.phase ?? 'idle';
  let status: HTMLElement;
  if (phase === 'searching') status = h('span', { class: 'chip' }, spinner(), 'Pesquisando no Spotify…');
  else if (phase === 'done') status = h('span', { class: 'chip ok' }, icon('check', 14), 'Pesquisa concluída');
  else if (phase === 'error') status = h('span', { class: 'chip bad' }, icon('alert', 14), 'Pesquisa falhou');
  else status = h('span', { class: 'chip' }, snap?.auth.connected ? 'Aguardando' : 'Não pesquisada');

  put(card, 
    h('div', { class: 'media-title', title: media.title }, media.title),
    h('div', { class: 'media-sub', title: `Título obtido via ${SOURCE_LABEL[media.source]}` }, sub),
    h(
      'div',
      { class: 'chips' },
      h('span', { class: `chip play-${media.playback}` }, h('span', { class: 'dot' }), PLAYBACK_LABEL[media.playback]),
      status,
    ),
  );
  return card;
}

/** Em sites fora da lista, oferece detectar só nesta aba ou sempre neste site. */
function renderSiteAccess(state: State, a: Actions): HTMLElement | null {
  const t = state.tab;
  if (!t.injectable) return null;
  if (t.builtin || t.customEnabled) {
    // O Chrome não injeta scripts em abas que já estavam abertas antes de instalar/recarregar a extensão.
    return h(
      'div',
      { class: 'site-access' },
      h('p', { class: 'hint' }, `${t.builtin ? 'Este site é compatível' : 'Site habilitado'} — dê play na mídia e aguarde um instante. Se nada aparecer, a aba pode ter sido aberta antes da extensão: recarregue a página ou use o botão abaixo.`),
      h('div', { class: 'row gap wrap' }, h('button', { class: 'btn small', onClick: a.detectHere, title: 'Injeta o detector nesta aba' }, 'Detectar nesta aba')),
      state.siteNotice ? h('p', { class: 'hint', role: 'status' }, state.siteNotice) : null,
    );
  }
  return h(
    'div',
    { class: 'site-access' },
    h('p', { class: 'hint' }, `Este site (${t.origin ? new URL(t.origin).hostname : ''}) não está na lista de compatíveis. Você escolhe se a extensão pode ler a mídia dele:`),
    h(
      'div',
      { class: 'row gap wrap' },
      h('button', { class: 'btn small', onClick: a.detectHere, title: 'Injeta o detector somente nesta aba, uma vez' }, 'Detectar nesta aba'),
      h('button', { class: 'btn small ghost', onClick: a.alwaysHere, title: 'Pede permissão do Chrome para este site' }, 'Sempre neste site'),
    ),
    state.siteNotice ? h('p', { class: 'hint', role: 'status' }, state.siteNotice) : null,
  );
}

/* ---------------- resultado ---------------- */

function renderResult(state: State, a: Actions): HTMLElement | null {
  const snap = state.snapshot;
  if (!snap?.media) return null;
  const card = h('section', { class: 'card', 'aria-labelledby': 'h-result' }, h('h2', { id: 'h-result', class: 'card-label' }, 'Resultado no Spotify'));
  const manual = snap.search.manualSearchUrl;
  const manualBtn = manual ? h('button', { class: 'btn small ghost', onClick: () => a.openManualSearch(manual) }, icon('search', 14), 'Pesquisar manualmente no Spotify') : null;

  if (!snap.auth.configured) {
    put(card, 
      h(
        'div',
        { class: 'notice' },
        h('p', {}, 'Para pesquisar no Spotify, cadastre o Client ID do seu app nas configurações. O passo a passo está no README.'),
        h('div', { class: 'row gap wrap' }, h('button', { class: 'btn primary', onClick: a.openSettings }, 'Abrir configurações'), manualBtn),
      ),
    );
    return card;
  }

  if (!snap.auth.connected) {
    put(card, 
      h(
        'div',
        { class: 'notice' },
        icon('lock', 20),
        h('p', {}, 'Conecte sua conta para pesquisar a faixa no Spotify. A Web API exige uma sessão de usuário até para buscas.'),
        h('div', { class: 'row gap wrap' }, h('button', { class: 'btn primary', onClick: a.connect, disabled: state.connecting }, state.connecting ? 'Conectando…' : 'Conectar ao Spotify'), manualBtn),
      ),
    );
    return card;
  }

  const phase = snap.search.phase;
  if (phase === 'searching' || state.retrying) {
    put(card, 
      h(
        'div',
        { class: 'result skeleton', 'aria-busy': 'true' },
        h('div', { class: 'cover placeholder shimmer' }),
        h('div', { class: 'result-body' }, h('div', { class: 'line shimmer w70' }), h('div', { class: 'line shimmer w50' }), h('div', { class: 'line shimmer w40' })),
      ),
    );
    return card;
  }

  if (phase === 'error' && snap.search.error) {
    put(card, renderError(snap.search.error, a, false), manualBtn ? h('div', { class: 'row' }, manualBtn) : null);
    return card;
  }

  if (phase === 'idle') {
    put(card, 
      h(
        'div',
        { class: 'notice' },
        h('p', {}, 'A pesquisa automática está desligada.'),
        h('div', { class: 'row gap wrap' }, h('button', { class: 'btn primary', onClick: a.retrySearch }, 'Pesquisar agora'), manualBtn),
      ),
    );
    return card;
  }

  const outcome = snap.search.outcome;
  if (!outcome || outcome.status === 'not-found' || outcome.matches.length === 0) {
    put(card, 
      h(
        'div',
        { class: 'notice' },
        icon('search', 20),
        h('strong', {}, 'Não encontramos essa faixa no Spotify'),
        h('p', { class: 'muted' }, 'Pode ser um vídeo que não é música, uma versão rara ou uma faixa indisponível na sua região. Tente uma pesquisa manual.'),
        h('div', { class: 'row gap wrap' }, manualBtn, h('button', { class: 'btn small', onClick: a.retrySearch }, icon('refresh', 14), 'Tentar de novo')),
        outcome?.debug ? renderDebug(outcome.debug) : null,
      ),
    );
    return card;
  }

  const idx = Math.min(state.matchIndex, outcome.matches.length - 1);
  const match = outcome.matches[idx] as ScoredMatch;
  const t = match.track;
  const meta = [t.album, formatDuration(t.durationMs)].filter(Boolean).join(' · ');

  put(card, 
    h(
      'div',
      { class: 'result' },
      safeImg(t.albumArtUrl, 'cover', `Capa de ${t.album}`),
      h(
        'div',
        { class: 'result-body' },
        h('div', { class: 'track-name', title: t.name }, t.name, t.explicit ? h('span', { class: 'tag', title: 'Conteúdo explícito' }, 'E') : null),
        h('div', { class: 'track-artist', title: t.artists.join(', ') }, t.artists.join(', ')),
        h('div', { class: 'track-meta', title: meta }, meta),
        h('div', { class: `confidence ${match.confidence}` }, CONFIDENCE_LABEL[match.confidence]),
        t.isPlayable === false ? h('div', { class: 'warn-text' }, 'Indisponível na sua região') : null,
      ),
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn primary', onClick: () => a.listen(t) }, icon('play', 16), 'Ouvir no Spotify'),
      h('button', { class: 'btn', onClick: a.openPlaylistPanel }, icon('plus', 16), 'Adicionar à playlist'),
    ),
    h(
      'div',
      { class: 'row gap wrap links' },
      h('button', { class: 'link', onClick: () => a.openWeb(t) }, icon('external', 13), 'Abrir no Spotify Web'),
      manualBtn && h('button', { class: 'link', onClick: () => manual && a.openManualSearch(manual) }, icon('search', 13), 'Não é essa? Pesquisar'),
    ),
    state.appOpenAttempted
      ? h(
          'p',
          { class: 'hint', role: 'status' },
          'Pedimos ao Chrome para abrir o aplicativo do Spotify. Não conseguimos confirmar se ele abriu — se nada aconteceu, use “Abrir no Spotify Web”.',
        )
      : null,
  );

  if (outcome.matches.length > 1) {
    const list = h('div', { class: 'alts' });
    outcome.matches.forEach((m, i) => {
      put(list, 
        h(
          'button',
          { class: `alt${i === idx ? ' selected' : ''}`, onClick: () => a.selectMatch(i), 'aria-pressed': i === idx },
          safeImg(m.track.albumArtUrl, 'cover-sm'),
          h('span', { class: 'alt-text' }, h('span', { class: 'alt-name' }, m.track.name), h('span', { class: 'alt-artist' }, m.track.artists.join(', '))),
          h('span', { class: 'alt-dur' }, formatDuration(m.track.durationMs)),
        ),
      );
    });
    put(card, h('details', { class: 'more' }, h('summary', {}, `Outras possibilidades (${outcome.matches.length - 1})`), list));
  }
  // Correspondência fraca ou duvidosa: o diagnóstico também ajuda a entender (e a corrigir) o que aconteceu.
  if (outcome.debug && (match.confidence === 'weak' || match.confidence === 'low')) put(card, renderDebug(outcome.debug));
  return card;
}

/** Texto simples com o que foi enviado e o que o Spotify devolveu, para diagnosticar "não encontrado". */
function renderDebug(d: NonNullable<SearchOutcome['debug']>): HTMLElement {
  const lines: string[] = [];
  if (d.market) lines.push(`Mercado: ${d.market}`);
  lines.push('Leituras do título:');
  for (const r of d.readings) lines.push(`  • ${r.artist ? `${r.artist} — ` : ''}${r.title}`);
  lines.push('Consultas enviadas:');
  for (const q of d.queries) lines.push(`  • (${q.returned} resultados) ${q.q}`);
  lines.push('Melhores candidatas (nota 0–1; mínimo 0,45):');
  if (d.top.length === 0) lines.push('  (o Spotify não devolveu nenhuma faixa)');
  for (const t of d.top) lines.push(`  • ${t.score.toFixed(2)}  ${t.name} — ${t.artists.join(', ') || '(sem artista)'} [${formatDuration(t.durationMs)}]`);
  return h('details', { class: 'more debug' }, h('summary', {}, 'Detalhes técnicos'), h('pre', {}, lines.join('\n')));
}

/* ---------------- playlists ---------------- */

function matchesFilter(p: PlaylistSummary, filter: string): boolean {
  const f = fold(filter);
  return !f || fold(p.name).includes(f);
}

function renderPlaylistPanel(state: State, a: Actions): HTMLElement {
  const snap = state.snapshot;
  const outcome = snap?.search.outcome;
  const track = outcome?.matches[Math.min(state.matchIndex, (outcome?.matches.length ?? 1) - 1)]?.track;
  const pl = state.playlists;
  const panel = h('section', { class: 'card panel', 'aria-labelledby': 'h-pl' });

  put(panel, 
    h(
      'div',
      { class: 'panel-head' },
      h('h2', { id: 'h-pl', class: 'card-label' }, 'Adicionar à playlist'),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'icon-btn', onClick: a.refreshPlaylists, 'aria-label': 'Atualizar lista de playlists', title: 'Atualizar lista', disabled: pl.status === 'loading' }, icon('refresh')),
        h('button', { class: 'icon-btn', onClick: a.closePlaylistPanel, 'aria-label': 'Fechar', title: 'Fechar' }, icon('close')),
      ),
    ),
  );
  if (track) put(panel, h('p', { class: 'muted ellipsis' }, `${track.name} — ${track.artists.join(', ')}`), h('p', { class: 'hint tight' }, 'Marque quantas playlists quiser.'));

  put(panel, 
    h('input', {
      class: 'input',
      type: 'search',
      placeholder: 'Buscar playlist',
      'aria-label': 'Buscar playlist',
      'data-key': 'pl-filter',
      value: pl.filter,
      onInput: (e: Event) => a.setFilter((e.target as HTMLInputElement).value),
    }),
  );
  const filterInput = panel.querySelector<HTMLInputElement>('[data-key="pl-filter"]');
  if (filterInput) filterInput.value = pl.filter;

  if (pl.status === 'loading') {
    put(panel, h('div', { class: 'center muted pad' }, spinner(), h('span', {}, 'Carregando suas playlists…')));
  } else if (pl.status === 'error' && pl.error) {
    put(panel, renderError(pl.error, a, false));
  } else {
    const visible = pl.items.filter((p) => matchesFilter(p, pl.filter));
    const list = h('div', { class: 'pl-list', role: 'group', 'aria-label': 'Playlists (marque uma ou mais)' });
    if (visible.length === 0) {
      put(list, h('p', { class: 'muted pad' }, pl.items.length === 0 ? 'Você ainda não tem playlists. Crie uma abaixo.' : 'Nenhuma playlist com esse nome.'));
    }
    for (const p of visible) {
      const meta = [p.trackCount !== undefined ? `${p.trackCount} ${p.trackCount === 1 ? 'faixa' : 'faixas'}` : '', p.collaborative ? 'Colaborativa' : '', !p.editable ? 'Somente leitura' : '']
        .filter(Boolean)
        .join(' · ');
      const picked = pl.selectedIds.includes(p.id);
      const box = h('input', { type: 'checkbox', name: 'playlist', value: p.id, disabled: !p.editable, checked: picked, onChange: () => a.selectPlaylist(p.id) });
      put(list, 
        h(
          'label',
          { class: `pl-row${p.editable ? '' : ' disabled'}${picked ? ' selected' : ''}`, title: p.editable ? p.name : 'Você não pode editar esta playlist' },
          box,
          safeImg(p.imageUrl, 'cover-sm'),
          h('span', { class: 'pl-text' }, h('span', { class: 'pl-name' }, p.name), h('span', { class: 'pl-meta' }, meta)),
        ),
      );
    }
    put(panel, list);
  }

  // Nova playlist
  const create = state.create;
  if (create.open) {
    put(panel, 
      h(
        'div',
        { class: 'create' },
        h('input', {
          class: 'input',
          type: 'text',
          maxlength: '100',
          placeholder: 'Nome da nova playlist',
          'aria-label': 'Nome da nova playlist',
          'data-key': 'create-name',
          value: create.name,
          onInput: (e: Event) => a.setCreateName((e.target as HTMLInputElement).value),
          onKeydown: (e: Event) => {
            if ((e as KeyboardEvent).key === 'Enter') a.createAndAdd();
          },
        }),
        h(
          'label',
          { class: 'check' },
          h('input', { type: 'checkbox', checked: create.isPublic, onChange: (e: Event) => a.setCreatePublic((e.target as HTMLInputElement).checked) }),
          'Pública (padrão: privada)',
        ),
        h('div', { class: 'row gap' }, h('button', { class: 'btn small primary', onClick: a.createAndAdd, disabled: create.busy || !create.name.trim() }, create.busy ? 'Criando…' : 'Criar e adicionar'), h('button', { class: 'btn small ghost', onClick: a.toggleCreate }, 'Cancelar')),
      ),
    );
    const input = panel.querySelector<HTMLInputElement>('[data-key="create-name"]');
    if (input) input.value = create.name;
  } else {
    put(panel, h('button', { class: 'link', onClick: a.toggleCreate }, icon('plus', 13), 'Nova playlist'));
  }

  // Resultado da operação (uma linha de resumo por situação, já que dá para salvar em várias playlists)
  const add = state.add;
  const names = (items: AddResultItem[]) => items.map((r) => `“${r.playlistName}”`).join(', ');
  const added = add.results.filter((r) => r.status === 'added');
  const dups = add.results.filter((r) => r.status === 'duplicate');
  const errs = add.results.filter((r) => r.status === 'error');
  if (added.length > 0) {
    put(panel, h('div', { class: 'banner ok', role: 'status' }, icon('check', 18), h('div', { class: 'banner-body' }, h('strong', {}, 'Faixa adicionada!'), h('p', {}, `Salva em ${names(added)}.`))));
  }
  if (dups.length > 0) {
    put(
      panel,
      h(
        'div',
        { class: 'banner warn', role: 'status' },
        icon('alert', 18),
        h(
          'div',
          { class: 'banner-body' },
          h('strong', {}, dups.length === 1 ? 'Esta faixa já está na playlist' : 'Esta faixa já está em algumas playlists'),
          h('p', {}, `${names(dups)} já ${dups.length === 1 ? 'contém' : 'contêm'} essa música.`),
          h('button', { class: 'btn small', onClick: () => a.confirmAdd(true) }, 'Adicionar mesmo assim'),
        ),
      ),
    );
  }
  for (const r of errs) {
    const view = describeError(r.error ?? { kind: 'internal', message: 'Erro desconhecido.' });
    put(panel, h('div', { class: 'banner error', role: 'alert' }, icon('alert', 18), h('div', { class: 'banner-body' }, h('strong', {}, `Não foi possível adicionar a “${r.playlistName}”`), h('p', {}, view.title === 'Algo deu errado' ? view.detail : `${view.title}. ${view.detail}`))));
  }

  // Só conta como pendente o que ainda não foi salvo nesta faixa.
  const pending = pl.items.filter((p) => p.editable && pl.selectedIds.includes(p.id) && !added.some((r) => r.playlistId === p.id));
  const busy = add.status === 'adding';
  const allSaved = added.length > 0 && pending.length === 0;
  let label: string | (string | SVGSVGElement)[];
  if (busy) label = 'Adicionando…';
  else if (allSaved) label = [icon('check', 16), added.length === 1 ? 'Adicionada' : `Adicionada a ${added.length} playlists`];
  else if (pending.length === 0) label = 'Escolha uma ou mais playlists';
  else if (pending.length === 1) label = `Adicionar a “${(pending[0] as PlaylistSummary).name}”`;
  else label = `Adicionar a ${pending.length} playlists`;
  put(panel, h('div', { class: 'actions single' }, h('button', { class: 'btn primary', onClick: () => a.confirmAdd(false), disabled: pending.length === 0 || busy }, label)));
  return panel;
}

