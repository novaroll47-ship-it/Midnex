/**
 * Диагностика процесса без открытых портов: CPU-профиль через встроенный
 * `node:inspector` (сессия внутри процесса, наружу ничего не слушает).
 *
 * CPU_PROFILE="60,30" — через 60 с после старта снять профиль длиной 30 с и
 * записать `.tools/cpu-<время>.cpuprofile` (открывается в Chrome DevTools →
 * Performance → Load profile, или разбирается скриптом deploy/cpuprofile-top.mjs).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

export function scheduleCpuProfile(spec: string | undefined, dir: string, log: FastifyBaseLogger): void {
  if (!spec) return;
  const [delaySec, lengthSec] = spec.split(',').map((s) => Number(s.trim()));
  if (!delaySec || !lengthSec) return;
  setTimeout(() => {
    const session = new Session();
    session.connect();
    const post = (method: string) =>
      new Promise<unknown>((resolve, reject) =>
        session.post(method, (err, result) => (err ? reject(err) : resolve(result))),
      );
    void (async () => {
      try {
        await post('Profiler.enable');
        await post('Profiler.start');
        log.info(`diag: CPU-профиль ${lengthSec} с`);
        await new Promise((r) => setTimeout(r, lengthSec * 1000));
        const { profile } = (await post('Profiler.stop')) as { profile: unknown };
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `cpu-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
        writeFileSync(file, JSON.stringify(profile));
        log.info(`diag: профиль записан в ${file}`);
      } catch (err) {
        log.warn({ err: String(err) }, 'diag: профиль не снят');
      } finally {
        session.disconnect();
      }
    })();
  }, delaySec * 1000).unref();
}
