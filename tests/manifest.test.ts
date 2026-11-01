import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MATCHES } from '../src/shared/constants';
import { matchesAny, matchesPattern } from '../src/shared/match-pattern';

const root = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'src', 'manifest.json'), 'utf8')) as {
  manifest_version: number;
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions: string[];
  content_scripts: Array<{ matches: string[]; js: string[]; all_frames?: boolean; world?: string; run_at?: string }>;
  background: { service_worker: string; type?: string };
  action: { default_popup: string };
  options_ui: { page: string };
};

describe('manifest.json', () => {
  it('é Manifest V3 com service worker e sem páginas de background persistentes', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe('background.js');
  });

  it('pede somente as permissões necessárias (sem `tabs`, sem acesso a todos os sites por padrão)', () => {
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'identity', 'scripting', 'storage']);
    expect(manifest.host_permissions.sort()).toEqual(['https://accounts.spotify.com/*', 'https://api.spotify.com/*']);
    const everything = /^(\*|https?|\*):\/\/\*\/\*$|<all_urls>/;
    expect(manifest.host_permissions.some((p) => everything.test(p))).toBe(false);
    expect(manifest.content_scripts.flatMap((c) => c.matches).some((p) => everything.test(p))).toBe(false);
  });

  it('acesso a outros sites é opcional (concedido pelo usuário em tempo de execução)', () => {
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
  });

  it('os sites dos content scripts coincidem com BUILTIN_MATCHES (usado pelo popup)', () => {
    expect(manifest.content_scripts).toHaveLength(2);
    for (const cs of manifest.content_scripts) expect([...cs.matches].sort()).toEqual([...BUILTIN_MATCHES].sort());
  });

  it('o page-hook roda no mundo principal em document_start; o detector no mundo isolado (padrão)', () => {
    const hook = manifest.content_scripts.find((c) => c.js.includes('page-hook.js'));
    const detector = manifest.content_scripts.find((c) => c.js.includes('content.js'));
    expect(hook).toMatchObject({ world: 'MAIN', run_at: 'document_start' });
    expect(detector?.world).toBeUndefined();
  });

  it('as páginas referenciadas existem no código-fonte', () => {
    expect(existsSync(join(root, 'src', 'popup', manifest.action.default_popup))).toBe(true);
    expect(existsSync(join(root, 'src', 'options', manifest.options_ui.page))).toBe(true);
    for (const size of [16, 32, 48, 128]) expect(existsSync(join(root, 'public', 'icons', `icon-${size}.png`))).toBe(true);
  });
});

describe('segredos', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  }

  it('o código-fonte não contém client secret nem credenciais', () => {
    const offenders = walk(join(root, 'src')).filter((f) => /client[_-]?secret|api[_-]?key|password\s*[:=]/i.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('matchesPattern', () => {
  it('casa esquemas, subdomínios e caminhos', () => {
    expect(matchesPattern('https://www.youtube.com/watch?v=1', 'https://www.youtube.com/*')).toBe(true);
    expect(matchesPattern('https://youtube.com/watch', 'https://www.youtube.com/*')).toBe(false);
    expect(matchesPattern('https://artist.bandcamp.com/track/x', 'https://*.bandcamp.com/*')).toBe(true);
    expect(matchesPattern('https://bandcamp.com/', 'https://*.bandcamp.com/*')).toBe(true);
    expect(matchesPattern('https://evilbandcamp.com/', 'https://*.bandcamp.com/*')).toBe(false);
    expect(matchesPattern('http://www.youtube.com/', 'https://www.youtube.com/*')).toBe(false);
    expect(matchesPattern('https://a.com/x', '*://a.com/*')).toBe(true);
    expect(matchesPattern('chrome://extensions', '*://*/*')).toBe(false);
    expect(matchesPattern('não é url', 'https://a.com/*')).toBe(false);
  });

  it('matchesAny usa a lista de sites embutidos', () => {
    expect(matchesAny('https://music.youtube.com/watch?v=1', BUILTIN_MATCHES)).toBe(true);
    expect(matchesAny('https://example.com/', BUILTIN_MATCHES)).toBe(false);
  });
});
