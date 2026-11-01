// Empacota a extensão em dist/ (esbuild). Uso: npm run build  |  npm run watch
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const watch = process.argv.includes('--watch');

if (!existsSync('public/icons/icon-128.png')) {
  const r = spawnSync(process.execPath, ['scripts/generate-icons.mjs'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const entryPoints = {
  background: 'src/background/index.ts',
  content: 'src/content/index.ts',
  'page-hook': 'src/content/page-hook.ts',
  popup: 'src/popup/index.ts',
  options: 'src/options/index.ts',
};

const options = {
  entryPoints,
  outdir: 'dist',
  bundle: true,
  format: 'iife', // content scripts não suportam módulos ES; o service worker também fica simples
  target: 'chrome116',
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'info',
};

function copyStatic() {
  cpSync('src/manifest.json', 'dist/manifest.json');
  cpSync('src/popup/popup.html', 'dist/popup.html');
  cpSync('src/popup/popup.css', 'dist/popup.css');
  cpSync('src/options/options.html', 'dist/options.html');
  cpSync('src/options/options.css', 'dist/options.css');
  cpSync('public/icons', 'dist/icons', { recursive: true });
}

copyStatic();
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Observando alterações… (Ctrl+C para sair). Recarregue a extensão em chrome://extensions.');
} else {
  await build(options);
  console.log('Pronto: carregue a pasta dist/ em chrome://extensions (modo desenvolvedor).');
}
