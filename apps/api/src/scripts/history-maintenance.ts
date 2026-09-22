/**
 * Обслуживание истории в SQLite: резервная копия и возврат места.
 *
 *   node apps/api/dist/scripts/history-maintenance.js backup [папка]
 *     — онлайн-копия базы (не мешает работающему приложению) в папку
 *       (по умолчанию <папка базы>/backups), хранит последние 7 копий.
 *   node apps/api/dist/scripts/history-maintenance.js vacuum
 *     — VACUUM после больших удалений (сырые тики). Держит базу занятой
 *       минуты и требует свободного места в размер файла — запускать при
 *       остановленном приложении.
 *
 * Путь к базе — HISTORY_DB_PATH, иначе .data/history.sqlite в корне.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, '../../.env') });
dotenv.config({ path: join(here, '../../../../.env') });

// И из dist/scripts, и из src/scripts корень репозитория — четыре уровня вверх.
const dbPath =
  process.env.HISTORY_DB_PATH?.trim() || join(here, '../../../../.data/history.sqlite');

const [cmd, arg] = process.argv.slice(2);
const KEEP = 7;

if (!existsSync(dbPath)) {
  console.error(`Базы нет: ${dbPath}`);
  process.exit(1);
}

if (cmd === 'backup') {
  const dir = arg || join(dirname(dbPath), 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const target = join(dir, `history-${stamp}.sqlite`);
  const src = new DatabaseSync(dbPath, { readOnly: true });
  const started = Date.now();
  await backup(src, target, { rate: 1024 });
  src.close();
  const mb = (statSync(target).size / 1048576).toFixed(0);
  console.log(`Копия: ${target} (${mb} МБ, ${Math.round((Date.now() - started) / 1000)} с)`);
  // Старые копии — прочь, оставляем KEEP последних.
  const old = readdirSync(dir)
    .filter((f) => /^history-.*\.sqlite$/.test(f))
    .sort()
    .slice(0, -KEEP);
  for (const f of old) unlinkSync(join(dir, f));
  if (old.length) console.log(`Удалено старых копий: ${old.length}`);
} else if (cmd === 'vacuum') {
  const before = statSync(dbPath).size;
  const db = new DatabaseSync(dbPath);
  const started = Date.now();
  db.exec('pragma wal_checkpoint(TRUNCATE)');
  db.exec('vacuum');
  db.close();
  const after = statSync(dbPath).size;
  console.log(
    `VACUUM: ${(before / 1048576).toFixed(0)} → ${(after / 1048576).toFixed(0)} МБ за ${Math.round((Date.now() - started) / 1000)} с`,
  );
} else {
  console.error('Использование: history-maintenance backup [папка] | vacuum');
  process.exit(1);
}
