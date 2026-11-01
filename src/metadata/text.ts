/**
 * Utilitários de texto: dobra (fold) de caixa/acentos/pontuação e similaridade tolerante.
 * Funciona para qualquer script (usa classes Unicode), inclusive CJK e cirílico.
 */

const EMOJI_AND_SYMBOLS = /[\p{Extended_Pictographic}︎️‍⃣♩♪♫♬▶►◀▷◆◇★☆]/gu;

export function stripEmoji(s: string): string {
  return s.replace(EMOJI_AND_SYMBOLS, ' ');
}

/** Normaliza espaços (inclui NBSP e caracteres de largura zero). */
export function collapseSpaces(s: string): string {
  return s
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Forma "dobrada" para comparação: sem acentos, minúscula, sem apóstrofos, `&` → "and",
 * qualquer outra pontuação vira espaço.
 */
export function fold(s: string): string {
  return stripEmoji(s)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function compact(folded: string): string {
  return folded.replace(/ /g, '');
}

function tokenDice(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of b) counts.set(t, (counts.get(t) ?? 0) + 1);
  let inter = 0;
  for (const t of a) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      inter++;
      counts.set(t, c - 1);
    }
  }
  return (2 * inter) / (a.length + b.length);
}

function bigrams(s: string): string[] {
  const chars = Array.from(s);
  if (chars.length < 2) return chars.length === 1 ? [chars[0] as string] : [];
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push((chars[i] as string) + (chars[i + 1] as string));
  return out;
}

/**
 * Similaridade 0..1 entre dois textos. Combina Dice de tokens (palavras) com Dice de bigramas de
 * caracteres (tolera erros de digitação e idiomas sem espaços). Textos que só diferem por
 * espaços/pontuação ("R.E.M." × "REM") têm similaridade ≈ 1.
 */
export function similarity(a: string, b: string): number {
  const fa = fold(a);
  const fb = fold(b);
  if (!fa || !fb) return 0;
  if (fa === fb) return 1;
  const ca = compact(fa);
  const cb = compact(fb);
  if (ca === cb) return 0.98;
  const tok = tokenDice(fa.split(' '), fb.split(' '));
  const big = tokenDice(bigrams(ca), bigrams(cb));
  return Math.max(tok, big * 0.92);
}
