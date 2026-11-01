import type { Confidence, ErrorInfo, PlaybackState } from '../shared/types';

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const PLAYBACK_LABEL: Record<PlaybackState, string> = {
  playing: 'Tocando',
  paused: 'Pausado',
  ended: 'Encerrado',
};

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'Correspondência provável',
  medium: 'Confira se é a mesma música',
  low: 'Possível correspondência — confirme',
  weak: 'Pouco provável — confira com atenção',
};

export const SOURCE_LABEL = {
  site: 'player da página',
  mediasession: 'Media Session',
  element: 'elemento de mídia',
  document: 'título da aba',
} as const;

export interface ErrorView {
  title: string;
  detail: string;
  /** Ações sugeridas, na ordem. */
  actions: Array<'retry' | 'connect' | 'settings'>;
}

/** Converte um erro técnico em texto compreensível, com os próximos passos. */
export function describeError(err: ErrorInfo): ErrorView {
  switch (err.kind) {
    case 'not-configured':
      return {
        title: 'Falta configurar o app do Spotify',
        detail: 'Cadastre o Client ID do seu app nas configurações para poder conectar.',
        actions: ['settings'],
      };
    case 'unauthenticated':
      return { title: 'Sua sessão do Spotify expirou', detail: 'Conecte novamente para continuar.', actions: ['connect'] };
    case 'auth-denied':
      return { title: 'Login cancelado', detail: 'Nada foi alterado na sua conta. Você pode tentar conectar de novo.', actions: ['connect'] };
    case 'auth-failed':
      return { title: 'Não foi possível concluir o login', detail: err.message, actions: ['connect', 'settings'] };
    case 'network':
      return { title: 'Sem conexão com o Spotify', detail: 'Verifique sua internet e tente de novo.', actions: ['retry'] };
    case 'rate-limit':
      return {
        title: 'Muitas requisições ao Spotify',
        detail: err.retryAfterSec ? `Aguarde cerca de ${err.retryAfterSec} s e tente de novo.` : 'Aguarde um instante e tente de novo.',
        actions: ['retry'],
      };
    case 'forbidden':
      return {
        title: 'O Spotify negou o acesso',
        detail: `${err.message} Em apps em Development Mode, o usuário precisa estar cadastrado em “User Management” no Dashboard e o dono do app precisa ter Premium.`,
        actions: ['retry', 'settings'],
      };
    case 'not-found':
      return { title: 'Item não encontrado', detail: err.message, actions: ['retry'] };
    default:
      return { title: 'Algo deu errado', detail: err.message, actions: ['retry'] };
  }
}
