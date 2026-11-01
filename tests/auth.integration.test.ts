import { describe, expect, it } from 'vitest';
import { AuthService } from '../src/spotify/auth';
import { codeChallengeS256, createPkcePair, randomString } from '../src/spotify/pkce';
import { AppError } from '../src/shared/errors';
import { FakeSpotify, REDIRECT, makeAuthDeps } from './helpers/fake-spotify';

async function expectAppError(p: Promise<unknown>, kind: string) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).kind).toBe(kind);
  return err as AppError;
}

describe('PKCE', () => {
  it('gera verifier válido (43–128 chars, alfabeto unreserved) e challenge S256 conforme RFC 7636', async () => {
    const v = randomString(96);
    expect(v).toHaveLength(96);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
    // Vetor de teste do apêndice B da RFC 7636.
    expect(await codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const pair = await createPkcePair();
    expect(pair.challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });

  it('não repete valores', () => {
    expect(randomString(32)).not.toBe(randomString(32));
  });
});

describe('AuthService.login', () => {
  it('conclui o fluxo Authorization Code + PKCE e guarda os tokens', async () => {
    const fake = new FakeSpotify();
    const h = makeAuthDeps(fake);
    const authorizeUrls: string[] = [];
    h.deps.launchWebAuthFlow = async (d) => {
      authorizeUrls.push(d.url);
      return fake.authorize(d);
    };
    await new AuthService(h.deps).login();

    const u = new URL(authorizeUrls[0] as string);
    expect(u.searchParams.get('client_id')).toBe('client-123');
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toHaveLength(32);
    // Somente os escopos estritamente necessários.
    expect(u.searchParams.get('scope')?.split(' ').sort()).toEqual([
      'playlist-modify-private',
      'playlist-modify-public',
      'playlist-read-collaborative',
      'playlist-read-private',
    ]);
    expect(h.store.auth).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-0', clientId: 'client-123' });
    expect(h.store.auth?.expiresAt).toBe(h.clock.now + 3600_000);
    // Nada de client secret/senha no tráfego.
    const tokenCall = fake.calls.find((c) => c.url.pathname === '/api/token');
    expect(String(tokenCall?.body)).not.toMatch(/secret|password/i);
    expect(String(tokenCall?.body)).toContain('code_verifier=');
  });

  it('rejeita resposta com `state` diferente (CSRF) e não salva nada', async () => {
    const fake = new FakeSpotify();
    const h = makeAuthDeps(fake, {
      launchWebAuthFlow: async (d) => (await fake.authorize(d)).replace(/state=[^&]+/, 'state=forjado'),
    });
    await expectAppError(new AuthService(h.deps).login(), 'auth-failed');
    expect(h.store.auth).toBeUndefined();
    expect(fake.calls.some((c) => c.url.pathname === '/api/token')).toBe(false);
  });

  it('rejeita resposta sem `state`', async () => {
    const fake = new FakeSpotify();
    const h = makeAuthDeps(fake, {
      launchWebAuthFlow: async (d) => (await fake.authorize(d)).replace(/&state=[^&]+/, ''),
    });
    await expectAppError(new AuthService(h.deps).login(), 'auth-failed');
  });

  it('trata recusa do usuário e janela fechada como auth-denied', async () => {
    const fake = new FakeSpotify();
    const denied = makeAuthDeps(fake, {
      launchWebAuthFlow: async (d) => {
        const state = new URL(d.url).searchParams.get('state');
        return `${REDIRECT}?error=access_denied&state=${state}`;
      },
    });
    await expectAppError(new AuthService(denied.deps).login(), 'auth-denied');

    const closed = makeAuthDeps(fake, {
      launchWebAuthFlow: async () => {
        throw new Error('The user did not approve access.');
      },
    });
    await expectAppError(new AuthService(closed.deps).login(), 'auth-denied');
  });

  it('exige o Client ID configurado', async () => {
    const fake = new FakeSpotify();
    const h = makeAuthDeps(fake);
    h.settings.clientId = '  ';
    await expectAppError(new AuthService(h.deps).login(), 'not-configured');
  });

  it('libera o keepAlive mesmo quando o login falha', async () => {
    const fake = new FakeSpotify();
    let released = 0;
    const h = makeAuthDeps(fake, {
      keepAlive: () => () => void released++,
      launchWebAuthFlow: async () => {
        throw new Error('fechou');
      },
    });
    await expectAppError(new AuthService(h.deps).login(), 'auth-denied');
    expect(released).toBe(1);
  });
});

describe('AuthService — tokens', () => {
  async function connected() {
    const fake = new FakeSpotify();
    const h = makeAuthDeps(fake);
    const auth = new AuthService(h.deps);
    await auth.login();
    return { fake, h, auth };
  }

  it('reusa o token enquanto válido e renova perto da expiração', async () => {
    const { fake, h, auth } = await connected();
    expect(await auth.getAccessToken()).toBe('access-1');
    h.clock.now += 3600_000 - 30_000; // faltam 30 s: dentro da margem de 60 s
    expect(await auth.getAccessToken()).toBe('access-2');
    expect(fake.calls.filter((c) => String(c.body).includes('grant_type=refresh_token'))).toHaveLength(1);
  });

  it('mantém o refresh token antigo quando a resposta não traz outro', async () => {
    const { h, auth } = await connected();
    h.clock.now += 4000_000;
    await auth.getAccessToken();
    expect(h.store.auth?.refreshToken).toBe('refresh-0');
  });

  it('adota o novo refresh token quando a resposta traz um', async () => {
    const { fake, h, auth } = await connected();
    fake.rotateRefreshToken = true;
    h.clock.now += 4000_000;
    await auth.getAccessToken();
    expect(h.store.auth?.refreshToken).not.toBe('refresh-0');
    h.clock.now += 4000_000;
    await expect(auth.getAccessToken()).resolves.toBeTruthy(); // o novo token funciona
  });

  it('chamadas simultâneas compartilham UMA renovação', async () => {
    const { fake, h, auth } = await connected();
    h.clock.now += 4000_000;
    const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.forceRefresh()]);
    expect(new Set(tokens).size).toBe(1);
    expect(fake.calls.filter((c) => String(c.body).includes('grant_type=refresh_token'))).toHaveLength(1);
  });

  it('refresh token revogado/expirado (invalid_grant) desconecta e pede novo login', async () => {
    const { fake, h, auth } = await connected();
    fake.revokeRefreshTokens = true;
    h.clock.now += 4000_000;
    await expectAppError(auth.getAccessToken(), 'unauthenticated');
    expect(h.store.auth).toBeUndefined();
    expect(await auth.isConnected()).toBe(false);
  });

  it('falha de rede ao renovar NÃO apaga a sessão', async () => {
    const { h, auth } = await connected();
    h.clock.now += 4000_000;
    h.deps.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expectAppError(auth.getAccessToken(), 'network');
    expect(h.store.auth).toBeDefined();
  });

  it('mudar o Client ID invalida a sessão antiga', async () => {
    const { h, auth } = await connected();
    h.settings.clientId = 'outro-client';
    expect(await auth.isConnected()).toBe(false);
    expect(h.store.auth).toBeUndefined();
  });

  it('logout remove tokens e dados derivados', async () => {
    const { h, auth } = await connected();
    await auth.logout();
    expect(h.store.auth).toBeUndefined();
    expect(h.store.cleared).toBe(1);
    await expectAppError(auth.getAccessToken(), 'unauthenticated');
  });

  it('sem sessão, getAccessToken falha com unauthenticated', async () => {
    const fake = new FakeSpotify();
    await expectAppError(new AuthService(makeAuthDeps(fake).deps).getAccessToken(), 'unauthenticated');
  });
});
