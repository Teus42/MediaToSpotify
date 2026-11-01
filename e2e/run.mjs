// Orquestra o teste de ponta a ponta em um Chrome real (perfil temporário, nada do seu perfil é tocado):
//   1. empacota o mock do Spotify e uma variante de TESTE da extensão (URLs apontando para o mock);
//   2. sobe o mock em 127.0.0.1:8777;
//   3. roda os cenários (detecção, OAuth+PKCE, busca, popup, playlists, desconectar).
// Uso: npm run e2e
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const out = join(here, '.out');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, 'mock-server.ts')],
  outfile: join(out, 'mock-server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
  logLevel: 'warning',
});

const built = spawnSync(process.execPath, [join(here, 'build-test.mjs')], { stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);

const mock = spawn(process.execPath, [join(out, 'mock-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  mock.stdout.on('data', (d) => String(d).includes('mock ready') && resolve());
  mock.on('exit', (code) => reject(new Error(`mock encerrou (${code}); a porta 8777 está ocupada?`)));
});

const scenarios = spawn(process.execPath, [join(here, 'scenarios.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
const code = await new Promise((resolve) => scenarios.on('exit', resolve));
mock.kill();
process.exit(code ?? 1);
