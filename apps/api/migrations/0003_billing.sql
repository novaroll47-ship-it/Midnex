-- Подписки и оплаты (этап «платный скринер»).
--
-- subscriptions: один тариф на пользователя; покупка продлевает срок от
-- текущего конца. payments: заявки — звёзды закрываются автоматически по
-- successful_payment, крипта — вручную админом через бота.
create table if not exists subscriptions (
  user_id      bigint primary key references users(id) on delete cascade,
  plan         text not null default 'screener',
  expires_at   timestamptz not null,
  source       text not null,
  updated_at   timestamptz not null default now(),
  reminded_at  timestamptz
);
alter table subscriptions enable row level security;

create table if not exists payments (
  id                  text primary key,
  user_id             bigint not null references users(id) on delete cascade,
  plan                text not null,
  months              int not null,
  method              text not null,
  amount              numeric not null,
  currency            text not null,
  status              text not null default 'pending',
  network             text,
  tx_hash             text,
  telegram_charge_id  text,
  note                text,
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz
);
create index if not exists payments_user_idx on payments (user_id, created_at desc);
create index if not exists payments_status_idx on payments (status);
alter table payments enable row level security;
