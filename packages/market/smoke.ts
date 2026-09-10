// Дымовой прогон движка: стартует, ждёт котировки, печатает статус и топ спредов.
import { MarketEngine } from './src/index.js';

const log = {
  info: (m: string) => console.log('  ', m),
  warn: (m: string) => console.log('  !', m),
};

const engine = new MarketEngine({
  exchanges: ['binance', 'bybit', 'okx', 'mexc', 'bitget', 'bingx', 'gate', 'kucoin'],
  staleMs: 10000,
  pollMs: 2000,
  holdMinutes: 240,
  log,
});

console.log('старт…');
const t0 = Date.now();
await engine.start();
console.log(`рынки загружены за ${Date.now() - t0}мс\n`);

for (const wait of [8, 12, 25]) {
  await new Promise((r) => setTimeout(r, (wait === 8 ? 8 : wait === 12 ? 4 : 13) * 1000));
  const st = engine.status();
  console.log(`--- ${wait}с: вселенная ${st.universeSize} монет`);
  for (const f of st.feeds) {
    console.log(
      `   ${f.exchange.padEnd(8)} ${f.mode.padEnd(4)} ${f.status.padEnd(12)} ` +
        `символов ${String(f.symbols).padStart(4)} котировок ${String(f.quoted).padStart(4)} ` +
        `задержка ${f.latencyMs ?? '—'}мс реконнектов ${f.reconnects}` +
        (f.lastError ? `  ошибка: ${f.lastError.slice(0, 60)}` : ''),
    );
  }
}

const snap = engine.snapshot(0.5);
console.log(
  `\nстрок ${snap.rows.length}, выше порога 0.5%: ${snap.opportunities}, устаревших: ${snap.rows.filter((r) => r.stale).length}`,
);
console.log('\nТОП-8 по спреду:');
for (const r of snap.rows.slice(0, 8)) {
  console.log(
    `   ${r.base.padEnd(8)} ${r.longExchange.padEnd(7)} ${r.longPrice.toPrecision(6).padStart(12)} → ` +
      `${r.shortExchange.padEnd(7)} ${r.shortPrice.toPrecision(6).padStart(12)}  ` +
      `спред ${r.spreadPct.toFixed(3)}%  комиссии ${r.feesPct.toFixed(2)}%  ` +
      `фандинг ${r.fundingKnown ? r.fundingPct.toFixed(4) + '%' : '?'}  чист. ${r.netPct.toFixed(3)}%`,
  );
}
console.log('\nBTC:');
const btc = engine.coinDetail('BTC');
for (const q of btc?.quotes ?? []) {
  console.log(
    `   ${q.exchange.padEnd(8)} bid ${q.bid.toFixed(2)} ask ${q.ask.toFixed(2)} фандинг ${q.fundingPct.toFixed(4)}% ${q.stale ? 'УСТАРЕЛО' : ''}`,
  );
}

await engine.stop();
process.exit(0);
