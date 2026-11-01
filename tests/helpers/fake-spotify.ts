import { createHash } from 'node:crypto';
import type { AuthDeps } from '../../src/spotify/auth';
import type { StoredAuth } from '../../src/shared/storage';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/types';

export const REDIRECT = 'https://abcdefghijklmnop.chromiumapp.org/';

export interface Call {
  method: string;
  url: URL;
  body?: unknown;
  headers: Record<string, string>;
}

/**
 * Servidor Spotify de mentira: implementa só o necessário (authorize/token com verificação PKCE
 * real, /search, /me, /me/playlists, /playlists/{id}/items) e registra todas as chamadas.
 */
export class FakeSpotify {
  calls: Call[] = [];
  /** Respostas forçadas por "METHOD /path" (consumidas na ordem). */
  forced = new Map<string, Array<() => Response | Promise<Response>>>();

  clientId = 'client-123';
  accessTokenCounter = 0;
  validAccessToken = '';
  refreshToken = 'refresh-0';
  rotateRefreshToken = false;
  expiresIn = 3600;
  revokeRefreshTokens = false;

  private codes = new Map<string, { challenge: string; redirect: string; clientId: string }>();
  playlists: Array<Record<string, unknown>> = [];
  playlistItems = new Map<string, string[]>();
  searchResults: Array<Record<string, unknown> | null> = [];
  searchByQuery: Map<string, Array<Record<string, unknown> | null>> = new Map();

  force(key: string, ...responses: Array<() => Response | Promise<Response>>): void {
    this.forced.set(key, responses);
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = { method, url, headers };
    if (rawBody !== undefined) call.body = headers['Content-Type']?.includes('json') ? JSON.parse(rawBody) : rawBody;
    this.calls.push(call);

    const key = `${method} ${url.pathname}`;
    const queue = this.forced.get(key);
    if (queue && queue.length > 0) return (queue.shift() as () => Response | Promise<Response>)();

    if (url.hostname === 'accounts.spotify.com' && url.pathname === '/api/token') return this.token(new URLSearchParams(rawBody));
    return this.api(method, url, call);
  };

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  private issueAccessToken(): string {
    this.validAccessToken = `access-${++this.accessTokenCounter}`;
    return this.validAccessToken;
  }

  private token(form: URLSearchParams): Response {
    if (form.has('client_secret')) return this.json(400, { error: 'invalid_request', error_description: 'client_secret não esperado' });
    if (form.get('client_id') !== this.clientId) return this.json(400, { error: 'invalid_client' });

    if (form.get('grant_type') === 'authorization_code') {
      const entry = this.codes.get(form.get('code') ?? '');
      if (!entry) return this.json(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
      this.codes.delete(form.get('code') as string);
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== entry.challenge) return this.json(400, { error: 'invalid_grant', error_description: 'code_verifier was incorrect' });
      if (form.get('redirect_uri') !== entry.redirect) return this.json(400, { error: 'invalid_grant', error_description: 'Invalid redirect URI' });
      return this.json(200, {
        access_token: this.issueAccessToken(),
        token_type: 'Bearer',
        scope: 'playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public',
        expires_in: this.expiresIn,
        refresh_token: this.refreshToken,
      });
    }

    if (form.get('grant_type') === 'refresh_token') {
      if (this.revokeRefreshTokens || form.get('refresh_token') !== this.refreshToken) {
        return this.json(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
      }
      const body: Record<string, unknown> = {
        access_token: this.issueAccessToken(),
        token_type: 'Bearer',
        expires_in: this.expiresIn,
        scope: 'playlist-read-private',
      };
      if (this.rotateRefreshToken) {
        this.refreshToken = `refresh-${this.accessTokenCounter}`;
        body.refresh_token = this.refreshToken;
      }
      return this.json(200, body);
    }
    return this.json(400, { error: 'unsupported_grant_type' });
  }

  /** Simula a página de consentimento: valida o pedido de autorização e devolve a URL de redirecionamento. */
  authorize = async (details: { url: string; interactive: boolean }): Promise<string> => {
    const u = new URL(details.url);
    const p = u.searchParams;
    if (u.origin + u.pathname !== 'https://accounts.spotify.com/authorize') throw new Error('URL de autorização inesperada');
    if (p.get('response_type') !== 'code') throw new Error('response_type deve ser code');
    if (p.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 obrigatório');
    const code = `code-${this.codes.size + 1}-${Math.random().toString(36).slice(2)}`;
    this.codes.set(code, { challenge: p.get('code_challenge') as string, redirect: p.get('redirect_uri') as string, clientId: p.get('client_id') as string });
    return `${p.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(p.get('state') as string)}`;
  };

  private api(method: string, url: URL, call: Call): Response {
    const auth = call.headers.Authorization;
    if (auth !== `Bearer ${this.validAccessToken}`) return this.json(401, { error: { status: 401, message: 'The access token expired' } });

    const path = url.pathname.replace(/^\/v1/, '');
    if (method === 'GET' && path === '/me') return this.json(200, { id: 'me-id', display_name: 'Usuário Teste' });

    if (method === 'GET' && path === '/search') {
      const q = url.searchParams.get('q') ?? '';
      const items = this.searchByQuery.get(q) ?? this.searchResults;
      return this.json(200, { tracks: { items } });
    }

    if (method === 'GET' && path === '/me/playlists') {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const items = this.playlists.slice(offset, offset + limit);
      const next = offset + limit < this.playlists.length ? 'https://api.spotify.com/v1/me/playlists?next' : null;
      return this.json(200, { items, next, total: this.playlists.length });
    }

    if (method === 'POST' && path === '/me/playlists') {
      const body = call.body as { name: string; public: boolean };
      const created = { id: `pl-${this.playlists.length + 1}`, name: body.name, collaborative: false, owner: { id: 'me-id' }, images: [], items: { total: 0 } };
      this.playlists.unshift(created);
      return this.json(201, created);
    }

    const itemsMatch = /^\/playlists\/([^/]+)\/items$/.exec(path);
    if (itemsMatch) {
      const id = decodeURIComponent(itemsMatch[1] as string);
      const list = this.playlistItems.get(id) ?? [];
      if (method === 'POST') {
        const uris = (call.body as { uris: string[] }).uris;
        this.playlistItems.set(id, [...list, ...uris]);
        return this.json(201, { snapshot_id: 'snap' });
      }
      if (method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 20);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const slice = list.slice(offset, offset + limit).map((uri) => ({ item: { uri } }));
        return this.json(200, { items: slice, next: offset + limit < list.length ? 'next' : null, total: list.length });
      }
    }
    return this.json(404, { error: { status: 404, message: 'Not found' } });
  }
}

export interface AuthHarness {
  deps: AuthDeps;
  store: { auth?: StoredAuth; cleared: number };
  settings: Settings;
  clock: { now: number };
}

export function makeAuthDeps(fake: FakeSpotify, overrides: Partial<AuthDeps> = {}): AuthHarness {
  const store: AuthHarness['store'] = { cleared: 0 };
  const settings: Settings = { ...DEFAULT_SETTINGS, clientId: fake.clientId };
  const clock = { now: 1_700_000_000_000 };
  const deps: AuthDeps = {
    getSettings: async () => settings,
    loadAuth: async () => store.auth,
    saveAuth: async (a) => {
      store.auth = a;
    },
    clearAll: async () => {
      store.auth = undefined;
      store.cleared++;
    },
    getRedirectUrl: () => REDIRECT,
    launchWebAuthFlow: fake.authorize,
    fetch: fake.fetch as typeof fetch,
    now: () => clock.now,
    ...overrides,
  };
  return { deps, store, settings, clock };
}

export function rawTrack(id: string, name: string, artist: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    uri: `spotify:track:${id}`,
    name,
    duration_ms: 200_000,
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    artists: [{ name: artist }],
    album: { name: 'Album', album_type: 'album', images: [{ url: `https://img/${id}-640.jpg`, width: 640 }, { url: `https://img/${id}-64.jpg`, width: 64 }] },
    ...extra,
  };
}
