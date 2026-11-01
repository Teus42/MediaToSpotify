import { mediaKey } from '../shared/media-key';
import { getSession } from '../shared/storage';
import type { SearchOutcome } from '../shared/types';

/** Selo no ícone: "✓" quando há correspondência para a mídia da aba, "?" quando só há palpite. */
export async function updateBadges(key: string, outcome: SearchOutcome | null): Promise<void> {
  const tabs = (await getSession('tabs')) ?? {};
  for (const [id, entry] of Object.entries(tabs)) {
    if (mediaKey(entry.media) !== key) continue;
    const best = outcome?.matches[0];
    const text = !best ? '' : best.confidence === 'low' || best.confidence === 'weak' ? '?' : '✓';
    try {
      await chrome.action.setBadgeText({ tabId: Number(id), text });
      if (text) await chrome.action.setBadgeBackgroundColor({ tabId: Number(id), color: text === '✓' ? '#1f9d55' : '#b7791f' });
    } catch {
      /* aba fechada */
    }
  }
}

export async function clearBadge(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    /* aba fechada */
  }
}
