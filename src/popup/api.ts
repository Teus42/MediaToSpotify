import type { Request, ResponseMap, Response } from '../shared/messages';
import type { ErrorInfo } from '../shared/types';

/** Erro vindo do service worker, já com `kind` para a interface decidir a mensagem. */
export class ApiError extends Error {
  constructor(readonly info: ErrorInfo) {
    super(info.message);
    this.name = 'ApiError';
  }
}

/** Envia um pedido ao service worker e devolve só o `data`, lançando ApiError em falhas. */
export async function send<R extends Request>(req: R): Promise<ResponseMap[R['type']]> {
  let res: Response<ResponseMap[R['type']]> | undefined;
  try {
    res = (await chrome.runtime.sendMessage(req)) as Response<ResponseMap[R['type']]> | undefined;
  } catch (err) {
    throw new ApiError({ kind: 'internal', message: err instanceof Error ? err.message : 'Falha ao falar com a extensão.' });
  }
  if (!res) throw new ApiError({ kind: 'internal', message: 'A extensão não respondeu. Tente reabrir o popup.' });
  if (!res.ok) throw new ApiError(res.error);
  return res.data;
}
