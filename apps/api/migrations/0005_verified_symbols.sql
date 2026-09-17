-- Сверка ног: символ на бирже ↔ монета. В ленту попадают только пары,
-- у которых обе ноги verified; множитель — отсюда.
create table if not exists verified_symbols (
  exchange    text not null,
  symbol      text not null,
  base        text not null,
  multiplier  numeric not null default 1,
  status      text not null default 'candidate',
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (exchange, symbol)
);
create index if not exists verified_symbols_base on verified_symbols (base);
create index if not exists verified_symbols_status on verified_symbols (status);
alter table verified_symbols enable row level security;
