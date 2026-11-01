/** Primitivas do PKCE (RFC 7636) e geração de `state`. Usa apenas Web Crypto. */

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** String aleatória com caracteres "unreserved", sem viés de módulo (rejection sampling). */
export function randomString(length: number, cryptoImpl: Crypto = crypto): string {
  const limit = 256 - (256 % UNRESERVED.length);
  let out = '';
  while (out.length < length) {
    const bytes = cryptoImpl.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit && out.length < length) out += UNRESERVED[b % UNRESERVED.length];
    }
  }
  return out;
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** code_challenge = BASE64URL(SHA256(code_verifier)) */
export async function codeChallengeS256(verifier: string, cryptoImpl: Crypto = crypto): Promise<string> {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** O verifier deve ter entre 43 e 128 caracteres; usamos 96. */
export async function createPkcePair(cryptoImpl: Crypto = crypto): Promise<PkcePair> {
  const verifier = randomString(96, cryptoImpl);
  return { verifier, challenge: await codeChallengeS256(verifier, cryptoImpl) };
}
