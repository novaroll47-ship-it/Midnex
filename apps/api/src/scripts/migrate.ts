/**
 * Миграции Postgres: применяет apps/api/migrations/*.sql по порядку.
 *
 *   npm run migrate -w @cs/api          (dev, из исходников)
 *   node apps/api/dist/scripts/migrate.js   (прод, из сборки; deploy/update.sh)
 *
 * Применённые файлы помечаются в schema_migrations. Все миграции написаны
 * идемпотентно (`if not exists`), поэтому на базе, куда их раньше накатывали
 * вручную через SQL Editor, первый запуск ничего не сломает — просто отметит
 * их как применённые. Без DATABASE_URL (или =memory) делать нечего.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, '../../.env') });
dotenv.config({ path: join(here, '../../../../.env') });

const url = process.env.DATABASE_URL?.trim();
if (!url || url === 'memory') {
  console.log('DATABASE_URL не задан — миграции не нужны (хранилище в памяти).');
  process.exit(0);
}

// И из dist/scripts/, и из src/scripts/ папка migrations — два уровня вверх.
const dir = join(here, '../../migrations');
if (!existsSync(dir)) {
  console.error(`Папка migrations не найдена: ${dir}`);
  process.exit(1);
}

// NOTICE «уже существует» — норма для идемпотентных миграций, в вывод не нужны.
const sql = postgres(url, {
  prepare: false,
  max: 1,
  ssl: 'require',
  connect_timeout: 20,
  onnotice: () => {},
});
try {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const applied = new Set(
    (await sql`select name from schema_migrations`).map((r) => String(r['name'])),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = readFileSync(join(dir, file), 'utf-8');
    process.stdout.write(`→ ${file} … `);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    console.log('ок');
    ran++;
  }
  console.log(ran === 0 ? 'Миграции: всё уже применено.' : `Миграции: применено ${ran}.`);
} finally {
  await sql.end();
}
