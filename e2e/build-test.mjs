// Monta uma variante de TESTE da extensão (URLs do Spotify apontando para o mock local).
// O código do projeto NÃO é alterado: o patch é aplicado só durante o empacotamento.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT = join(import.meta.dirname, '..');
export const OUT = join(PROJECT, 'e2e', '.out', 'dist-test');
const BASE = 'http://127.0.0.1:8777';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const patchConstants = {
  name: 'patch-constants',
  setup(b) {
    b.onLoad({ filter: /shared[\\/]constants\.ts$/ }, (args) => {
      let src = readFileSync(args.path, 'utf8');
      src = src
        .replace(/SPOTIFY_AUTH_URL = '[^']+'/, `SPOTIFY_AUTH_URL = '${BASE}/authorize'`)
        .replace(/SPOTIFY_TOKEN_URL = '[^']+'/, `SPOTIFY_TOKEN_URL = '${BASE}/api/token'`)
        .replace(/SPOTIFY_API_BASE = '[^']+'/, `SPOTIFY_API_BASE = '${BASE}/v1'`)
        .replace("'https://music.apple.com/*',", "'https://music.apple.com/*',\n  'http://127.0.0.1:8777/*',");
      return { contents: src, loader: 'ts' };
    });
  },
};

await build({
  entryPoints: {
    background: join(PROJECT, 'src/background/index.ts'),
    content: join(PROJECT, 'src/content/index.ts'),
    'page-hook': join(PROJECT, 'src/content/page-hook.ts'),
    popup: join(PROJECT, 'src/popup/index.ts'),
    options: join(PROJECT, 'src/options/index.ts'),
  },
  outdir: OUT,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  platform: 'browser',
  plugins: [patchConstants],
  logLevel: 'warning',
});

const manifest = JSON.parse(readFileSync(`${PROJECT}/src/manifest.json`, 'utf8'));
manifest.host_permissions.push(`${BASE}/*`);
for (const cs of manifest.content_scripts) cs.matches.push(`${BASE}/*`);
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
for (const f of ['popup.html', 'popup.css']) cpSync(`${PROJECT}/src/popup/${f}`, join(OUT, f));
for (const f of ['options.html', 'options.css']) cpSync(`${PROJECT}/src/options/${f}`, join(OUT, f));
cpSync(`${PROJECT}/public/icons`, join(OUT, 'icons'), { recursive: true });
console.log('Extensão de teste pronta em', OUT);
