/**
 * Mini helper de DOM. Todo texto entra por `textContent` (nunca innerHTML), então títulos de
 * mídia vindos de páginas da web não podem injetar HTML no popup.
 */

type Child = Node | string | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('aria-') && value !== null && value !== undefined) {
      el.setAttribute(key, String(value)); // aria-* precisa de "true"/"false" explícitos
      continue;
    }
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  put(el, ...children);
  return el;
}

/** Como `append`, mas ignora null/false e aceita listas aninhadas. */
export function put(parent: Element, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) put(parent, ...child);
    else parent.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/** Ícones SVG estáticos (strings confiáveis definidas aqui, não vindas de dados externos). */
const ICON_PATHS: Record<string, string> = {
  gear: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4.5v15l12-7.5-12-7.5Z"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  note: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
};

export function icon(name: keyof typeof ICON_PATHS | string, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = ICON_PATHS[name] ?? '';
  return svg;
}

/** Logotipo próprio da extensão (barras de equalizador sobre um disco verde); não imita marcas de terceiros. */
export function logo(size = 28): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const bars: Array<[number, number]> = [[7.5, 7], [11.75, 14], [16, 20], [20.25, 11], [24.5, 16]];
  svg.innerHTML =
    '<circle cx="16" cy="16" r="16" fill="#25d366"/>' +
    bars.map(([cx, hgt]) => `<rect x="${cx - 1.4}" y="${16 - hgt / 2}" width="2.8" height="${hgt}" rx="1.4" fill="#06210f"/>`).join('');
  return svg;
}

/** Preserva foco e posição do cursor quando a interface é redesenhada. */
export function withFocusPreserved(render: () => void): void {
  const active = document.activeElement as (HTMLInputElement & { dataset: DOMStringMap }) | null;
  const key = active?.dataset?.key;
  const start = active?.selectionStart ?? null;
  const end = active?.selectionEnd ?? null;
  render();
  if (!key) return;
  const next = document.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(key)}"]`);
  if (!next) return;
  next.focus();
  if (start !== null && end !== null && typeof next.setSelectionRange === 'function') {
    try {
      next.setSelectionRange(start, end);
    } catch {
      /* tipos de input sem seleção */
    }
  }
}
