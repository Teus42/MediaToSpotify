/**
 * Normalização de títulos de mídia: remove ruído ("Official Video", resolução, emojis…),
 * separa "Artista - Título", extrai participações (feat.) e marcas de versão (live, remix…).
 *
 * Tudo aqui é puro e roda localmente — nenhum título sai do navegador por este módulo.
 */

import { collapseSpaces, fold, similarity, stripEmoji } from './text';

export type Variant =
  | 'live'
  | 'remix'
  | 'acoustic'
  | 'instrumental'
  | 'cover'
  | 'karaoke'
  | 'sped-up'
  | 'slowed'
  | 'reverb'
  | 'nightcore'
  | '8d'
  | 'extended'
  | 'radio-edit'
  | 'demo'
  | 'remaster';

/** Padrões aplicados sobre texto já "dobrado" (sem acento, minúsculo). */
const VARIANT_PATTERNS: ReadonlyArray<readonly [Variant, RegExp]> = [
  ['live', /\b(live|ao vivo|en vivo|en directo|unplugged|en concierto)\b/],
  ['remix', /\b(remix|rmx|bootleg|rework)\b/],
  ['acoustic', /\b(acoustic|acustico|acustica|acustique)\b/],
  ['instrumental', /\binstrumental\b/],
  ['cover', /\bcover\b/],
  ['karaoke', /\bkaraoke\b/],
  ['sped-up', /\b(sped up|speed up|spedup)\b/],
  ['slowed', /\bslowed\b/],
  ['reverb', /\breverb\b/],
  ['nightcore', /\bnightcore\b/],
  ['8d', /\b8d\b/],
  ['extended', /\bextended\b/],
  ['radio-edit', /\b(radio|single) edit\b/],
  ['demo', /\bdemo\b/],
  ['remaster', /\b(remaster|remastered|remasterizado|remasterizada|remasterisee)\b/],
];

export function detectVariants(text: string): Variant[] {
  const f = fold(text);
  const out: Variant[] = [];
  for (const [variant, re] of VARIANT_PATTERNS) if (re.test(f)) out.push(variant);
  return out;
}

/* ------------------------------------------------------------------ */
/* Ruído                                                                */
/* ------------------------------------------------------------------ */

const STRONG_NOISE = new Set([
  'official', 'oficial', 'officiel', 'ufficiale', 'offiziell',
  'lyrics', 'lyric', 'letra', 'letras', 'paroles', 'testo', 'lirik',
  'videoclip', 'videoclipe', 'clipe', 'clip',
  'visualizer', 'visualiser',
  'hd', 'hq', '4k', '8k', 'mv', 'mp3', 'premiere', 'teaser',
  'legendado', 'legenda', 'traducao', 'traduccion', 'subtitulado', 'subtitulos', 'sub', 'subs', 'vostfr',
  'topic', 'vevo',
]);
const WEAK_NOISE = new Set(['video', 'music', 'song', 'full', 'album', 'audio', 'explicit', 'clean']);
const FILLER = new Set(['the', 'de', 'do', 'da', 'la', 'el', 'com', 'con', 'with', 'new', 'nuevo', 'novo', 'in', 'of', 'and', 'y', 'e', 'a']);

/** Nomes de sites que aparecem como sufixo do título da aba. */
const SITE_NAMES = new Set([
  'youtube', 'youtube music', 'soundcloud', 'bandcamp', 'deezer', 'tidal', 'apple music', 'spotify',
  'vimeo', 'dailymotion', 'twitch', 'mixcloud', 'audiomack', 'last fm',
]);

function isNoiseSegment(segment: string, inBrackets: boolean): boolean {
  const f = fold(segment);
  if (!f) return true;
  if (SITE_NAMES.has(f)) return true;
  let strong = 0;
  let weak = 0;
  for (const token of f.split(' ')) {
    if (STRONG_NOISE.has(token) || /^\d{3,4}p$|^\d+fps$|^\d+k$/.test(token)) strong++;
    else if (WEAK_NOISE.has(token)) weak++;
    else if (FILLER.has(token) || /^(19|20)\d{2}$/.test(token)) continue;
    else return false;
  }
  return strong > 0 || weak >= 2 || (inBrackets && weak >= 1);
}

/* ------------------------------------------------------------------ */
/* Colchetes, participações e nomes de artista                          */
/* ------------------------------------------------------------------ */

const BRACKET_RE = /[(\[{（［【][^()\[\]{}（）［］【】]*[)\]}）］】]/gu;
const STRAY_BRACKETS_RE = /[()\[\]{}（）［］【】]/g;
const FEAT_IN_BRACKETS_RE = /^(?:feat|ft|featuring|with)\b\.?\s+(.+)$/i;
const FEAT_TRAILING_RE = /^(.*?)\s*\b(?:feat|ft|featuring)\b\.?\s+(.+)$/i;

export function splitNames(s: string, splitOnAnd = true): string[] {
  const re = splitOnAnd ? /\s*(?:,|;|&|\bx\b|×|\band\b)\s*/i : /\s*(?:,|;|&|\bx\b|×)\s*/i;
  return s
    .split(re)
    .map((p) => collapseSpaces(p))
    .filter(Boolean);
}

/** Remove sufixos típicos de nome de canal: "- Topic", "VEVO", "Official"… */
export function cleanArtistName(raw: string): string {
  let s = collapseSpaces(stripEmoji(raw));
  s = s.replace(/\s*[-–—]\s*topic$/i, '');
  s = s.replace(/\s*vevo$/i, '');
  s = s.replace(/\s+(?:official|oficial)(?:\s+(?:youtube\s+)?(?:channel|page|artist channel))?$/i, '');
  s = s.replace(/\s+(?:channel|canal oficial)$/i, '');
  return collapseSpaces(s);
}

export function isTopicChannel(channel: string | undefined): boolean {
  return !!channel && /\s[-–—]\s*topic$/i.test(channel.trim());
}

/** Conteúdo de colchetes que não é ruído, versão nem feat.: pode ser um apelido do título ou o artista. */
interface BracketExtra {
  text: string;
  open: string;
  /** Veio antes de qualquer outro texto (ex.: "【Ado】好きでいて"). */
  leading: boolean;
}

interface BracketAnalysis {
  text: string;
  variants: Set<Variant>;
  featured: string[];
  extras: BracketExtra[];
}

function analyzeBrackets(raw: string): BracketAnalysis {
  const variants = new Set<Variant>();
  const featured: string[] = [];
  const extras: BracketExtra[] = [];
  let text = raw;
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    text = text.replace(BRACKET_RE, (match, offset: number) => {
      const inner = match.slice(1, -1).trim();
      const feat = FEAT_IN_BRACKETS_RE.exec(inner);
      if (feat) {
        featured.push(...splitNames(feat[1] as string));
        return ' ';
      }
      const found = detectVariants(inner);
      if (found.length > 0) {
        for (const v of found) variants.add(v);
        return ' ';
      }
      // Ruído ("Official Video") sai de vez. O resto ("Suki de Ite", "【Ado】", "Taylor's Version") sai
      // do núcleo do título mas é guardado: pode ser o nome romanizado/traduzido da música ou o artista.
      if (inner && !isNoiseSegment(inner, true)) {
        extras.push({ text: inner, open: match.charAt(0), leading: text.slice(0, offset).trim() === '' });
      }
      return ' ';
    });
    if (text === before) break;
  }
  return { text: text.replace(STRAY_BRACKETS_RE, ' '), variants, featured, extras };
}

const SEGMENT_SPLIT_RE = /\s+[-–—―]+\s+|\s*[–—―]+\s*|\s*[|｜]\s*/;

function stripWrappingQuotes(s: string): string {
  const m = /^(["“«「『])(.+)(["”»」』])$/.exec(s);
  return m ? (m[2] as string).trim() : s;
}

function trimJunk(s: string): string {
  return collapseSpaces(s.replace(/^[\s\-–—|:,.;~]+|[\s\-–—|:;~,]+$/g, ''));
}

const TRAILING_VARIANT_RE = /\s+(remix|acoustic|instrumental|karaoke|nightcore|remastered|remaster)$/i;

/**
 * Remove sufixo de ruído solto no fim ("… Official Music Video", "… Lyrics HD"), mesmo sem
 * parênteses. Só corta quando o trecho final contém uma palavra de ruído forte ou 2+ fracas,
 * e nunca remove a primeira palavra.
 */
function stripTrailingNoise(s: string): string {
  const words = s.split(' ');
  let first = -1;
  let strong = 0;
  let weak = 0;
  for (let i = words.length - 1; i >= 1; i--) {
    const t = fold(words[i] as string);
    if (!t) continue;
    if (STRONG_NOISE.has(t) || /^\d{3,4}p$|^\d+fps$|^\d+k$/.test(t)) {
      strong++;
      first = i;
    } else if (WEAK_NOISE.has(t)) {
      weak++;
      first = i;
    } else if (FILLER.has(t) || /^(19|20)\d{2}$/.test(t)) continue;
    else break;
  }
  if (first < 0 || !(strong > 0 || weak >= 2)) return s;
  return words.slice(0, first).join(' ');
}

/** "Artista「Título」 resto" / `Artista "Título"`: separa o que vem antes, o título entre aspas e o resto. */
const QUOTED_RE = /^(.*?)\s*[「『“«"](.+?)[」』”»"]\s*(.*)$/u;

const NOT_AN_ALIAS_RE = /^(?:prod|produced|from|ost|op|ed|tv|cv|ft|feat|vo|music|lyrics?)\b|\b(?:version|ver\.?|edit|mix|size|remaster(?:ed)?|ost|pv|mv)\b/i;

/** O conteúdo entre colchetes parece um nome alternativo da música (romanização, tradução)? */
function isAliasLike(text: string, avoid: string[]): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (!/\p{L}/u.test(t) || /^[\d\s.,:'"-]+$/u.test(t)) return false;
  if (/[|｜]/.test(t) || NOT_AN_ALIAS_RE.test(t)) return false;
  const f = fold(t);
  return !avoid.some((a) => a && fold(a) === f);
}

/** "【Ado】Título": colchetes no início e curtos costumam trazer o artista. */
function isArtistTag(extra: BracketExtra): boolean {
  return extra.leading && /^[【［\[]$/.test(extra.open) && extra.text.length <= 40 && /\p{L}/u.test(extra.text);
}

/** O segmento tem a forma `Artista「Título」…` (artista antes, título entre aspas)? */
function hasQuotedArtistTitle(segment: string): boolean {
  const m = QUOTED_RE.exec(segment);
  return !!m && !!(m[1] ?? '').trim() && !!(m[2] ?? '').trim();
}

function extractFeat(segment: string, featured: string[]): string {
  const m = FEAT_TRAILING_RE.exec(segment);
  if (!m) return segment;
  featured.push(...splitNames(m[2] as string));
  return (m[1] as string).trim();
}

/* ------------------------------------------------------------------ */
/* API pública                                                          */
/* ------------------------------------------------------------------ */

export interface TitleCandidate {
  title: string;
  artist?: string;
  /** 0..1 — confiança de que a leitura (título/artista) é a correta. */
  weight: number;
}

export interface ParsedQuery {
  rawTitle: string;
  /** Leituras possíveis, da mais para a menos provável. */
  candidates: TitleCandidate[];
  featured: string[];
  variants: Variant[];
  /** Artista inferido do canal (ex.: "Artista - Topic"), se houver. */
  channelArtist?: string;
  /** Nomes alternativos da música achados entre colchetes (ex.: romanização). */
  aliases: string[];
  album?: string;
}

export interface ParseInput {
  title: string;
  artist?: string;
  channel?: string;
  album?: string;
}

/**
 * Interpreta o título bruto de uma mídia.
 *
 * Estratégia (em ordem):
 *  1. Remove emojis, colchetes e segmentos de ruído; extrai feat. e variantes.
 *  2. Se a página informou o artista (Media Session / adaptador), usa-o.
 *  3. Senão, tenta "A - B" nas duas ordens, usando o nome do canal para desempatar.
 *  4. Título solto: usa o canal como dica fraca de artista.
 */
export function parseMediaTitle(input: ParseInput): ParsedQuery {
  const rawTitle = collapseSpaces(stripEmoji(input.title));
  const featured: string[] = [];
  const variants = new Set<Variant>();

  const brackets = analyzeBrackets(rawTitle);
  brackets.featured.forEach((f) => featured.push(f));
  brackets.variants.forEach((v) => variants.add(v));

  let segments = brackets.text
    .split(SEGMENT_SPLIT_RE)
    .map(trimJunk)
    .filter((s) => s.length > 0);

  // Remove ruído e numeração ("01"), mas nunca deixa a lista vazia.
  const kept = segments.filter((s) => !isNoiseSegment(s, false) && !/^\d{1,3}$/.test(s));
  segments = kept.length > 0 ? kept : segments.slice(0, 1);

  // Segmentos além do 2º costumam ser "Live at…", álbum, gravadora: só contribuem com variantes.
  const main = segments.slice(0, 2);
  for (const extra of segments.slice(2)) detectVariants(extra).forEach((v) => variants.add(v));

  const cleanSegment = (s: string): string => {
    let t = extractFeat(stripTrailingNoise(s), featured);
    t = stripWrappingQuotes(t);
    const trailing = TRAILING_VARIANT_RE.exec(t);
    if (trailing) {
      detectVariants(trailing[1] as string).forEach((v) => variants.add(v));
      t = t.replace(TRAILING_VARIANT_RE, '');
    }
    return trimJunk(t);
  };

  const channelClean = input.channel ? cleanArtistName(input.channel) : '';
  const channelArtist = isTopicChannel(input.channel) ? channelClean : undefined;
  const pageArtistRaw = input.artist ? cleanArtistName(input.artist) : '';
  const candidates: TitleCandidate[] = [];

  if (pageArtistRaw) {
    // O artista veio da página: o título é o segmento que NÃO parece ser o artista.
    let titleText: string;
    if (main.length >= 2) {
      const [a, b] = main as [string, string];
      if (similarity(a, pageArtistRaw) >= 0.85) titleText = b;
      else if (similarity(b, pageArtistRaw) >= 0.85) titleText = a;
      else titleText = main.join(' - ');
    } else {
      titleText = main[0] ?? '';
    }
    const title = cleanSegment(titleText);
    const artist = splitNames(extractFeat(pageArtistRaw, featured), false)[0] ?? pageArtistRaw;
    if (title) {
      candidates.push({ title, artist, weight: 1 });
      // O "artista" da página às vezes é só o canal que enviou o vídeo.
      candidates.push({ title, weight: 0.85 });
    }
  } else if (main.length >= 2 && hasQuotedArtistTitle(main[0] as string)) {
    // "Artista「Título」Music Video | Nome do anime…": o 1º segmento já traz artista e título entre
    // aspas; os demais segmentos são só descrição (anime, gravadora, "Official Video"…).
    const [, before = '', inner = '', after = ''] = QUOTED_RE.exec(main[0] as string) as RegExpExecArray;
    detectVariants(after).forEach((v) => variants.add(v));
    for (const extra of main.slice(1)) detectVariants(extra).forEach((v) => variants.add(v));
    const title = cleanSegment(inner);
    const artist = cleanSegment(before);
    candidates.push({ title, artist, weight: 1 });
    candidates.push({ title, weight: 0.85 });
  } else if (main.length >= 2) {
    const [a, b] = main as [string, string];
    let first = { artist: cleanSegment(a), title: cleanSegment(b) };
    let second = { artist: cleanSegment(b), title: cleanSegment(a) };
    if (channelClean) {
      const simA = similarity(channelClean, a);
      const simB = similarity(channelClean, b);
      if (simB > simA && simB >= 0.7) [first, second] = [second, first];
    }
    candidates.push({ ...first, weight: 1 });
    candidates.push({ ...second, weight: 0.93 });
  } else if (main.length === 1) {
    const only = main[0] as string;
    const tag = brackets.extras.find(isArtistTag);
    if (tag && !QUOTED_RE.test(only)) {
      const tagged = cleanSegment(only);
      if (tagged) candidates.push({ artist: tag.text.trim(), title: tagged, weight: 1 });
    }
    const quoted = QUOTED_RE.exec(only);
    if (quoted) {
      const [, before = '', inner = '', after = ''] = quoted;
      detectVariants(after).forEach((v) => variants.add(v));
      const quotedTitle = cleanSegment(inner);
      const quotedArtist = cleanSegment(before) || channelClean;
      if (quotedTitle && quotedArtist) {
        candidates.push({ artist: quotedArtist, title: quotedTitle, weight: 1 });
      } else if (quotedTitle) {
        candidates.push({ title: quotedTitle, weight: 0.9 });
      }
    }
    const title = cleanSegment(only);
    if (title) {
      if (channelClean) candidates.push({ title, artist: channelClean, weight: channelArtist ? 1 : 0.88 });
      candidates.push({ title, weight: 0.85 });
    }
  }

  // Apelidos: "(Suki de Ite)" ao lado de "好きでいて" — o catálogo do Spotify costuma usar um dos dois.
  const artistTag = brackets.extras.find(isArtistTag);
  const knownNames = [channelClean, artistTag?.text ?? '', ...candidates.flatMap((c) => [c.title, c.artist ?? ''])];
  const aliases = brackets.extras
    .filter((e) => e !== artistTag && !e.leading && isAliasLike(e.text, knownNames))
    .map((e) => cleanSegment(e.text))
    .filter((t, i, all) => t && all.indexOf(t) === i)
    .slice(0, 2);
  if (aliases.length > 0) {
    const bases = candidates.filter((c) => c.artist).slice(0, 2);
    for (const base of bases.length > 0 ? bases : candidates.slice(0, 1)) {
      for (const alias of aliases) {
        const reading: TitleCandidate = { title: alias, weight: base.weight * 0.97 };
        if (base.artist) reading.artist = base.artist;
        candidates.push(reading);
      }
    }
  }

  if (candidates.length === 0) {
    const fallback = trimJunk(rawTitle);
    if (fallback) candidates.push({ title: fallback, weight: 0.7 });
  }

  const parsed: ParsedQuery = {
    rawTitle,
    candidates: dedupeCandidates(candidates),
    featured: dedupeStrings(featured),
    variants: [...variants],
    aliases,
  };
  if (channelArtist) parsed.channelArtist = channelArtist;
  if (input.album) parsed.album = input.album;
  return parsed;
}

function dedupeStrings(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = fold(item);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function dedupeCandidates(list: TitleCandidate[]): TitleCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = `${fold(c.title)}|${fold(c.artist ?? '')}`;
    if (!fold(c.title) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Análise do nome de uma faixa do Spotify (sufixos "- Remastered 2011", "(Live)", "(feat. X)"). */
export interface TrackNameAnalysis {
  core: string;
  variants: Variant[];
  featured: string[];
}

export function analyzeTrackName(name: string): TrackNameAnalysis {
  const featured: string[] = [];
  const brackets = analyzeBrackets(collapseSpaces(name));
  const variants = new Set<Variant>(brackets.variants);
  brackets.featured.forEach((f) => featured.push(f));
  const [head = '', ...rest] = brackets.text.split(/\s+[-–—―]+\s+/);
  for (const piece of rest) detectVariants(piece).forEach((v) => variants.add(v));
  let core = extractFeat(head, featured);
  const trailing = TRAILING_VARIANT_RE.exec(core);
  if (trailing) {
    detectVariants(trailing[1] as string).forEach((v) => variants.add(v));
    core = core.replace(TRAILING_VARIANT_RE, '');
  }
  return { core: trimJunk(core) || collapseSpaces(name), variants: [...variants], featured };
}

/**
 * Limpa o <title> de uma aba: remove contador de notificações "(3) ", ícones de reprodução
 * e o nome do site no final ("… - YouTube").
 */
export function cleanDocumentTitle(raw: string): string {
  let s = collapseSpaces(stripEmoji(raw));
  s = s.replace(/^\(\d+\)\s*/, '');
  const parts = s.split(/\s+[-–—|·•]\s+/);
  while (parts.length > 1 && SITE_NAMES.has(fold(parts[parts.length - 1] as string))) parts.pop();
  return collapseSpaces(parts.join(' - '));
}
