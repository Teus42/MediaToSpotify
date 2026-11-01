import { vi } from 'vitest';

/** chrome.storage em memória (local e session), suficiente para os serviços do background. */
function makeArea() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys == null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }),
    clear: vi.fn(async () => {
      data = {};
    }),
    dump: () => data,
  };
}

export function installFakeChrome() {
  const local = makeArea();
  const session = makeArea();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local, session },
    runtime: { id: 'test-extension-id' },
  };
  return { local, session };
}
