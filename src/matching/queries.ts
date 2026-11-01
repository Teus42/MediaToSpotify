import type { ParsedQuery } from '../metadata/title-parser';

const MAX_QUERIES = 4;

function escapeQuoted(s: string): string {
  return s.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Monta as consultas de busca do Spotify, da mais específica para a mais ampla.
 * A busca para assim que uma consulta produz uma correspondência confiável, então a maioria
 * das mídias gasta uma única requisição (no máximo 4).
 */
export function buildQueries(parsed: ParsedQuery): string[] {
  const queries: string[] = [];
  const push = (q: string) => {
    const trimmed = q.trim();
    if (trimmed && !queries.includes(trimmed)) queries.push(trimmed);
  };

  const withArtist = parsed.candidates.filter((c) => c.artist);
  const titleOnly = parsed.candidates.find((c) => !c.artist);

  // Consultas com filtros de campo para cada leitura com artista (inclui apelidos do título,
  // ex.: o nome romanizado entre parênteses), depois a busca livre da principal.
  for (const cand of withArtist.slice(0, 3)) {
    push(`track:"${escapeQuoted(cand.title)}" artist:"${escapeQuoted(cand.artist as string)}"`);
  }
  const primary = withArtist[0];
  if (primary?.artist) push(`${escapeQuoted(primary.title)} ${escapeQuoted(primary.artist)}`);
  if (titleOnly) push(escapeQuoted(titleOnly.title));
  else if (!primary) push(escapeQuoted(parsed.rawTitle));

  // Último recurso: o texto da mídia como está. A busca do Spotify é tolerante e, quando o título
  // não pôde ser dividido com segurança, é o que uma pessoa digitaria à mão.
  const fallback = escapeQuoted(parsed.rawTitle);
  const specific = queries.filter((q) => q !== fallback).slice(0, MAX_QUERIES - 1);
  return fallback ? [...specific, fallback] : specific;
}

/** Texto usado no link de pesquisa manual (não precisa de login). */
export function manualSearchText(parsed: ParsedQuery): string {
  const best = parsed.candidates[0];
  if (!best) return parsed.rawTitle;
  return best.artist ? `${best.artist} ${best.title}` : best.title;
}
