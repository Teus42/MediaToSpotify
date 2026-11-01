import { SPOTIFY_API_BASE } from '../shared/constants';
import { AppError } from '../shared/errors';

export interface ClientDeps {
  fetch: typeof fetch;
  /** Token de acesso válido (renova se estiver perto de expirar). */
  getAccessToken(): Promise<string>;
  /** Força uma renovação (usado após um 401). */
  refreshAccessToken(): Promise<string>;
  sleep(ms: number): Promise<void>;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

const MAX_RETRY_AFTER_SEC = 5;
const MAX_NETWORK_RETRIES = 2;

interface SpotifyErrorBody {
  error?: { status?: number; message?: string } | string;
  error_description?: string;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as SpotifyErrorBody;
    if (typeof body.error === 'string') return body.error_description ?? body.error;
    return body.error?.message ?? '';
  } catch {
    return '';
  }
}

/**
 * Cliente mínimo da Spotify Web API.
 *
 * Políticas:
 *  - 401 → renova o token UMA vez e repete;
 *  - 429 → respeita Retry-After; espera e repete uma vez se for curto, senão devolve `rate-limit`;
 *  - falhas de rede e 5xx → até 2 novas tentativas, somente para GET (idempotente);
 *  - qualquer outra falha vira AppError tipado, com a mensagem da API quando houver.
 */
export class SpotifyClient {
  constructor(private readonly deps: ClientDeps) {}

  get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(SPOTIFY_API_BASE + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const idempotent = method === 'GET';

    let refreshed = false;
    let waitedRateLimit = false;
    let transientAttempts = 0;

    for (;;) {
      const token = await this.deps.getAccessToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';

      let res: Response;
      try {
        res = await this.deps.fetch(url.toString(), {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch {
        if (idempotent && transientAttempts < MAX_NETWORK_RETRIES) {
          await this.deps.sleep(400 * 3 ** transientAttempts++);
          continue;
        }
        throw new AppError('network', 'Não foi possível falar com o Spotify. Verifique sua conexão.');
      }

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      if (res.status === 401) {
        if (!refreshed) {
          refreshed = true;
          await this.deps.refreshAccessToken();
          continue;
        }
        throw new AppError('unauthenticated', 'Sua sessão do Spotify expirou. Conecte novamente.', { status: 401 });
      }

      if (res.status === 429) {
        const retryAfter = Math.max(1, Number(res.headers.get('Retry-After')) || 1);
        if (retryAfter <= MAX_RETRY_AFTER_SEC && !waitedRateLimit) {
          waitedRateLimit = true;
          await this.deps.sleep(retryAfter * 1000 + 100);
          continue;
        }
        throw new AppError('rate-limit', 'O Spotify limitou as requisições. Tente de novo em instantes.', {
          retryAfterSec: retryAfter,
          status: 429,
        });
      }

      if (res.status >= 500 && idempotent && transientAttempts < MAX_NETWORK_RETRIES) {
        await this.deps.sleep(400 * 3 ** transientAttempts++);
        continue;
      }

      const apiMessage = await readErrorMessage(res);
      throw mapHttpError(res.status, apiMessage);
    }
  }
}

function mapHttpError(status: number, apiMessage: string): AppError {
  const detail = apiMessage ? ` (${apiMessage})` : '';
  switch (status) {
    case 400:
      return new AppError('bad-request', `O Spotify recusou a requisição${detail}.`, { status });
    case 403:
      return new AppError(
        'forbidden',
        `O Spotify negou o acesso${detail}. Verifique as permissões concedidas, se você tem permissão para editar a playlist e se o aplicativo está liberado para sua conta no Spotify Developer Dashboard.`,
        { status },
      );
    case 404:
      return new AppError('not-found', `Item não encontrado no Spotify${detail}.`, { status });
    default:
      return new AppError('api', `Erro do Spotify (${status})${detail}.`, { status });
  }
}
