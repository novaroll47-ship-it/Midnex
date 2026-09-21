-- Партнёрская программа для владельцев каналов (plan-partner-program).
--
-- partners — условия каждого партнёра; user_referrals — за кем закреплён
-- пользователь; partner_earnings — начисления (payment_id уникален: повторный
-- вебхук второго начисления не создаёт); partner_payouts — выплаты вручную.
-- Условия по умолчанию и минимальная выплата — в app_config
-- (partner_defaults, partner_min_payout).
create table if not exists partners (
  id                bigserial primary key,
  telegram_id       bigint not null unique,
  code              text not null unique,
  reward_percent    numeric not null,
  reward_months     int not null,
  attribution_days  int not null,
  hold_days         int not null,
  status            text not null default 'active',   -- active | paused
  paused_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table partners enable row level security;

create table if not exists user_referrals (
  user_id           bigint primary key,                -- без FK: переход по ссылке бывает раньше первого входа
  partner_id        bigint not null references partners(id),
  clicked_at        timestamptz not null default now(),
  attributed_until  timestamptz not null,
  -- Первая оплата: закрепление становится постоянным, бонусные дни выданы.
  converted_at      timestamptz
);
create index if not exists user_referrals_partner_idx on user_referrals (partner_id, clicked_at desc);
alter table user_referrals enable row level security;

create table if not exists partner_earnings (
  id                bigserial primary key,
  partner_id        bigint not null references partners(id),
  user_id           bigint not null,
  payment_id        text not null unique,
  months_rewarded   int not null,
  month_price       numeric not null,
  reward_percent    numeric not null,
  amount            numeric not null,
  status            text not null default 'on_hold',  -- on_hold | available | paid
  created_at        timestamptz not null default now(),
  available_at      timestamptz not null,
  paid_at           timestamptz,
  payout_id         bigint
);
create index if not exists partner_earnings_partner_idx on partner_earnings (partner_id, status);
alter table partner_earnings enable row level security;

create table if not exists partner_payouts (
  id                bigserial primary key,
  partner_id        bigint not null references partners(id),
  amount            numeric not null,
  paid_at           timestamptz not null default now(),
  reference         text
);
alter table partner_payouts enable row level security;
