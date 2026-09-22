// После сборки кладём рядом с каждым файлом в dist/ его .gz и .br:
// @fastify/static с preCompressed отдаёт их как есть, и сервер не жмёт
// 750 КБ JS заново на каждое открытие приложения.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const EXT = new Set(['.js', '.css', '.html', '.svg', '.json', '.txt', '.map']);
const MIN = 1024;

let files = 0;
let saved = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
      continue;
    }
    const ext = name.slice(name.lastIndexOf('.'));
    if (!EXT.has(ext) || st.size < MIN) continue;
    const src = readFileSync(p);
    const gz = gzipSync(src, { level: 9 });
    const br = brotliCompressSync(src, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: src.length,
      },
    });
    writeFileSync(`${p}.gz`, gz);
    writeFileSync(`${p}.br`, br);
    files++;
    saved += src.length - br.length;
  }
}
walk(dist);
console.log(`precompress: ${files} файлов, brotli экономит ${(saved / 1024).toFixed(0)} КБ`);
