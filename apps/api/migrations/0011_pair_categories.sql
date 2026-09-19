-- Сверка: категория аномалии и «виноватая» нога — для группировки очереди;
-- ручной номинал инструмента — одно решение закрывает все его пары.
alter table verified_pairs add column if not exists category text;
alter table verified_pairs add column if not exists anomaly_leg text;
create table if not exists instrument_nominals (
  exchange   text not null,
  symbol     text not null,
  -- сырая цена контракта = factor × цена одной монеты; 0 — инструмент отклонён
  factor     numeric not null,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (exchange, symbol)
);
alter table instrument_nominals enable row level security;
