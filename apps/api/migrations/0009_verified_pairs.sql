-- Сверка пар бирж: между какими ногами одной монеты спред считать можно.
-- Заполняется автоматически (по цене, по стандартному множителю, по
-- внешнему источнику); в ручную очередь попадают только аномалии.
create table if not exists verified_pairs (
  base        text not null,
  exchange_a  text not null,
  symbol_a    text not null,
  exchange_b  text not null,
  symbol_b    text not null,
  -- цена_A ≈ multiplier × цена_B (сырые цены контрактов)
  multiplier  numeric not null default 1,
  status      text not null default 'candidate',   -- candidate | verified | rejected | delisted
  verification_source text,                        -- auto_price | auto_multiplier | external_match | manual
  ratio       numeric,                             -- последнее измеренное отношение цен
  external_a  text,                                -- coin id по внешнему источнику
  external_b  text,
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  verified_at timestamptz,
  primary key (exchange_a, symbol_a, exchange_b, symbol_b)
);
create index if not exists verified_pairs_base on verified_pairs (base);
create index if not exists verified_pairs_status on verified_pairs (status);
alter table verified_pairs enable row level security;
