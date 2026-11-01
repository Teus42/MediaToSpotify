/** Testa uma URL contra um match pattern de extensão (subconjunto: esquema://host/caminho com `*`). */
export function matchesPattern(url: string, pattern: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const m = /^(https?|\*):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, host, path] = m as unknown as [string, string, string, string];
  if (scheme !== '*' && `${scheme}:` !== parsed.protocol) return false;
  if (scheme === '*' && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const hostname = parsed.hostname;
  if (host === '*') {
    /* qualquer host */
  } else if (host.startsWith('*.')) {
    const base = host.slice(2);
    if (hostname !== base && !hostname.endsWith(`.${base}`)) return false;
  } else if (hostname !== host) {
    return false;
  }

  const pathRe = new RegExp('^' + path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return pathRe.test(parsed.pathname + parsed.search);
}

export function matchesAny(url: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(url, p));
}
