// Gera os ícones PNG da extensão (disco verde com barras de equalizador) sem dependências externas.
// Uso: npm run icons   →  public/icons/icon-{16,32,48,128}.png
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GREEN = [37, 211, 102];
const INK = [6, 33, 15];
// Barras num grid de 32x32: [centro x, altura]; largura fixa e cantos totalmente arredondados.
const BARS = [
  [7.5, 7],
  [11.75, 14],
  [16, 20],
  [20.25, 11],
  [24.5, 16],
];
const BAR_W = 2.8;

function inBar(x, y) {
  for (const [cx, h] of BARS) {
    const r = BAR_W / 2;
    const top = 16 - h / 2 + r;
    const bottom = 16 + h / 2 - r;
    const dx = Math.abs(x - cx);
    if (dx > r) continue;
    const cy = Math.min(Math.max(y, top), bottom);
    if (dx * dx + (y - cy) * (y - cy) <= r * r) return true;
  }
  return false;
}

function render(size) {
  const ss = 4; // supersampling 4x4
  const px = Buffer.alloc(size * size * 4);
  const scale = 32 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let cover = 0;
      let r = 0, g = 0, b = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const x = (i + (si + 0.5) / ss) * scale;
          const y = (j + (sj + 0.5) / ss) * scale;
          if ((x - 16) ** 2 + (y - 16) ** 2 > 16 * 16) continue;
          const c = inBar(x, y) ? INK : GREEN;
          cover++; r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = (j * size + i) * 4;
      if (cover > 0) {
        px[o] = Math.round(r / cover);
        px[o + 1] = Math.round(g / cover);
        px[o + 2] = Math.round(b / cover);
        px[o + 3] = Math.round((cover / (ss * ss)) * 255);
      }
    }
  }
  return px;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // profundidade
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filtro: nenhum
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon-${size}.png`), png(size, render(size)));
}
console.log('Ícones gerados em', outDir);
