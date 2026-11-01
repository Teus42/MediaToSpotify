import { SPOTIFY_AUTH_URL, SPOTIFY_SCOPES, SPOTIFY_TOKEN_URL } from '../shared/constants';
import { AppError } from '../shared/errors';
import type { StoredAuth } from '../shared/storage';
import type { Settings } from '../shared/types';
import { createPkcePair, randomString } from './pkce';

/**
 * Autenticação Spotify: Authorization Code com PKCE (cliente público, SEM client secret).
 *
 * Todo o acesso a tokens passa por esta classe, que só é instanciada no service worker.
 * O popup e as páginas de opções jamais recebem tokens — só pedem operações por mensagem.
 */

export interface AuthDeps {
  getSettings(): Promise<Settings>;
  loadAuth(): Promise<StoredAuth | undefined>;
  saveAuth(auth: StoredAuth): Promise<void>;
  /** Apaga sessão e dados derivados (perfil, cache de playlists). */
  clearAll(): Promise<void>;
  /** URL de redirecionamento da extensão: https://<id>.chromiumapp.org/ */
  getRedirectUrl(): string;
  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
  fetch: typeof fetch;
  now(): number;
  /** Mantém o service worker vivo enquanto a janela de login está aberta. */
  keepAlive?(): () => void;
  crypto?: Crypto;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/** Renova um pouco antes de expirar, para não falhar no meio de uma requisição. */
const EXPIRY_SKEW_MS = 60_000;

export class AuthService {
  private refreshing: Promise<StoredAuth> | null = null;

  constructor(private readonly deps: AuthDeps) {}

  /* ---------- login ---------- */

  async login(): Promise<void> {
    const { clientId } = await this.deps.getSettings();
    if (!clientId.trim()) {
      throw new AppError('not-configured', 'Informe o Client ID do seu app Spotify nas configurações antes de conectar.');
    }
    const cryptoImpl = this.deps.crypto ?? crypto;
    const { verifier, challenge } = await createPkcePair(cryptoImpl);
    const state = randomString(32, cryptoImpl);
    const redirectUri = this.deps.getRedirectUrl();

    const authUrl = new URL(SPOTIFY_AUTH_URL);
    authUrl.search = new URLSearchParams({
      client_id: clientId.trim(),
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SPOTIFY_SCOPES.join(' '),
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    }).toString();

    const release = this.deps.keepAlive?.();
    let responseUrl: string | undefined;
    try {
      responseUrl = await this.deps.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // "The user did not approve access" / janela fechada
      throw new AppError('auth-denied', `Login cancelado ou interrompido (${message}).`);
    } finally {
      release?.();
    }
    if (!responseUrl) throw new AppError('auth-denied', 'Login cancelado.');

    const params = new URL(responseUrl).searchParams;
    const returnedState = params.get('state');
    if (returnedState !== state) {
      throw new AppError('auth-failed', 'Resposta de login inválida (state não confere). Tente novamente.');
    }
    const error = params.get('error');
    if (error) {
      throw new AppError(error === 'access_denied' ? 'auth-denied' : 'auth-failed', `O Spotify recusou o login (${error}).`);
    }
    const code = params.get('code');
    if (!code) throw new AppError('auth-failed', 'O Spotify não devolveu o código de autorização.');

    const token = await this.requestToken(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId.trim(),
        code_verifier: verifier,
      },
      'exchange',
    );
    if (!token.access_token) throw new AppError('auth-failed', 'Resposta de token inválida do Spotify.');
    await this.deps.saveAuth(this.toStored(token, clientId.trim(), undefined));
  }

  /* ---------- sessão ---------- */

  /** Há sessão salva, emitida com o Client ID atual? */
  async isConnected(): Promise<boolean> {
    const stored = await this.loadValid();
    return !!stored;
  }

  /** Apaga tokens e dados derivados. O Spotify não expõe endpoint de revogação para PKCE. */
  async logout(): Promise<void> {
    await this.deps.clearAll();
  }

  async getAccessToken(): Promise<string> {
    const stored = await this.loadValid();
    if (!stored) throw new AppError('unauthenticated', 'Conecte sua conta do Spotify para continuar.');
    if (stored.expiresAt - EXPIRY_SKEW_MS > this.deps.now()) return stored.accessToken;
    return (await this.refresh(stored)).accessToken;
  }

  /** Força renovação (após 401). */
  async forceRefresh(): Promise<string> {
    const stored = await this.loadValid();
    if (!stored) throw new AppError('unauthenticated', 'Conecte sua conta do Spotify para continuar.');
    return (await this.refresh(stored)).accessToken;
  }

  /* ---------- internos ---------- */

  private async loadValid(): Promise<StoredAuth | undefined> {
    const stored = await this.deps.loadAuth();
    if (!stored) return undefined;
    const { clientId } = await this.deps.getSettings();
    // Client ID alterado: o refresh token pertence a outro app e não serve mais.
    if (stored.clientId !== clientId.trim()) {
      await this.deps.clearAll();
      return undefined;
    }
    return stored;
  }

  /** Renovação com "single flight": chamadas simultâneas compartilham a mesma requisição. */
  private refresh(stored: StoredAuth): Promise<StoredAuth> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh(stored).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(stored: StoredAuth): Promise<StoredAuth> {
    if (!stored.refreshToken) {
      await this.deps.clearAll();
      throw new AppError('unauthenticated', 'Sua sessão do Spotify expirou. Conecte novamente.');
    }
    const token = await this.requestToken(
      { grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: stored.clientId },
      'refresh',
    );
    if (!token.access_token) throw new AppError('auth-failed', 'Resposta de token inválida do Spotify.');
    // A resposta pode não trazer novo refresh token; nesse caso mantém-se o atual.
    const next = this.toStored(token, stored.clientId, stored.refreshToken);
    await this.deps.saveAuth(next);
    return next;
  }

  private toStored(token: TokenResponse, clientId: string, previousRefresh: string | undefined): StoredAuth {
    return {
      accessToken: token.access_token as string,
      refreshToken: token.refresh_token ?? previousRefresh,
      expiresAt: this.deps.now() + (token.expires_in ?? 3600) * 1000,
      scope: token.scope ?? '',
      clientId,
    };
  }

  private async requestToken(form: Record<string, string>, phase: 'exchange' | 'refresh'): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.deps.fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      throw new AppError('network', 'Não foi possível falar com o Spotify. Verifique sua conexão.');
    }

    let body: TokenResponse = {};
    try {
      body = (await res.json()) as TokenResponse;
    } catch {
      /* corpo não JSON */
    }

    if (!res.ok) {
      if (phase === 'refresh' && (body.error === 'invalid_grant' || body.error === 'invalid_client')) {
        // Refresh token revogado/expirado (vida útil de 6 meses): é preciso logar de novo.
        await this.deps.clearAll();
        throw new AppError('unauthenticated', 'Sua sessão do Spotify expirou. Conecte novamente.', { status: res.status });
      }
      if (res.status === 429) {
        throw new AppError('rate-limit', 'O Spotify limitou as requisições. Tente de novo em instantes.', {
          status: 429,
          retryAfterSec: Math.max(1, Number(res.headers.get('Retry-After')) || 5),
        });
      }
      if (res.status >= 500 && phase === 'refresh') {
        throw new AppError('network', 'O Spotify está indisponível no momento. Tente novamente.', { status: res.status });
      }
      const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
      throw new AppError('auth-failed', `Falha ao autenticar com o Spotify (${detail}).`, { status: res.status });
    }
    return body;
  }
}
