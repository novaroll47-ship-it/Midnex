// Разбор .cpuprofile: где процесс жжёт CPU. Показывает функции по собственному
// времени (self) и по времени с потомками (total), с файлом и строкой.
//
//   node deploy/cpuprofile-top.mjs .tools/cpu-....cpuprofile [--top=30]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node deploy/cpuprofile-top.mjs <file.cpuprofile> [--top=N]');
  process.exit(1);
}
const top = Number((process.argv.find((a) => a.startsWith('--top=')) ?? '--top=30').slice(6));
const p = JSON.parse(readFileSync(file, 'utf8'));

const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

// Время на сэмпл: timeDeltas — микросекунды между сэмплами.
const self = new Map();
for (let i = 0; i < p.samples.length; i++) {
  const dt = p.timeDeltas[i] ?? 0;
  self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + dt);
}
const totalUs = p.endTime - p.startTime;

const key = (n) => {
  const f = n.callFrame;
  const where = f.url ? `${f.url.replace(/^file:\/\/\/.*?\/node_modules\//, 'node_modules/').replace(/^file:\/\/\//, '')}:${f.lineNumber + 1}` : '';
  return `${f.functionName || '(anonymous)'}  ${where}`;
};

const selfByFn = new Map();
const totalByFn = new Map();
for (const [id, us] of self) {
  const n = byId.get(id);
  const k = key(n);
  selfByFn.set(k, (selfByFn.get(k) ?? 0) + us);
  // total: прибавляем всем предкам по одному разу на уникальную функцию.
  const seen = new Set();
  let cur = id;
  while (cur !== undefined) {
    const kk = key(byId.get(cur));
    if (!seen.has(kk)) {
      seen.add(kk);
      totalByFn.set(kk, (totalByFn.get(kk) ?? 0) + us);
    }
    cur = parent.get(cur);
  }
}

const pct = (us) => `${((us / totalUs) * 100).toFixed(1).padStart(5)}%`;
const print = (title, m) => {
  console.log(`\n== ${title} (профиль ${(totalUs / 1e6).toFixed(1)} с)`);
  for (const [k, us] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`${pct(us)}  ${(us / 1000).toFixed(0).padStart(7)} мс  ${k}`);
  }
};
print('по собственному времени (self)', selfByFn);
print('по времени с потомками (total)', totalByFn);
