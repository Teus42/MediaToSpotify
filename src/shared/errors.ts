import type { ErrorInfo, ErrorKind } from './types';

/** Erro tipado que sabe se serializar para o popup. */
export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly retryAfterSec?: number;
  readonly status?: number;

  constructor(kind: ErrorKind, message: string, extra: { retryAfterSec?: number; status?: number } = {}) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.retryAfterSec = extra.retryAfterSec;
    this.status = extra.status;
  }

  toInfo(): ErrorInfo {
    const info: ErrorInfo = { kind: this.kind, message: this.message };
    if (this.retryAfterSec !== undefined) info.retryAfterSec = this.retryAfterSec;
    if (this.status !== undefined) info.status = this.status;
    return info;
  }
}

export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof AppError) return err.toInfo();
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'internal', message };
}
