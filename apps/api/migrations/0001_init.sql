-- Схема MIDNEX, миграция 0001.
--
-- Сервер ходит в базу с полными правами; RLS включён с пустым набором политик,
-- чтобы публичный anon-ключ Supabase не давал доступа ни к одной строке.
-- Границей безопасности является сервер, а не база.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- пользователи

create table if not exists users (
  id            bigint primary key,                 -- Telegram user id
  username      text,
  first_name    text not null default '',
  language      text not null default 'ru',
  plan          text not null default 'screener'
                check (plan in ('screener', 'limited', 'unlimited')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- настройки

-- Настройки хранятся как jsonb: их структура задаётся кодом (@cs/shared),
-- а добавление поля не должно требовать миграции.
create table if not exists user_settings (
  user_id        bigint primary key references users(id) on delete cascade,
  bot            jsonb not null default '{}'::jsonb,
  risk           jsonb not null default '{}'::jsonb,
  notifications  jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------- ключи бирж

-- Секреты лежат только в зашифрованном виде (AES-256-GCM, ключ шифрования
-- в окружении сервера, не в базе). Открытым текстом — только метаданные.
create table if not exists exchange_keys (
  id                    uuid primary key default gen_random_uuid(),
  user_id               bigint not null references users(id) on delete cascade,
  exchange              text not null,
  label                 text not null default '',
  -- Формат: base64(iv) . base64(ciphertext) . base64(tag)
  api_key_enc           text not null,
  secret_enc            text not null,
  passphrase_enc        text,
  -- Первые символы ключа для узнавания в интерфейсе (как «...a1b2» у банков)
  key_hint              text not null default '',
  -- null — биржа не умеет отдавать права по API, проверка была ручной
  withdrawal_disabled   boolean,
  permissions_verified  boolean not null default false,
  status                text not null default 'unverified'
                        check (status in ('unverified', 'ok', 'invalid', 'withdrawal_enabled')),
  last_error            text,
  created_at            timestamptz not null default now(),
  last_checked_at       timestamptz,
  unique (user_id, exchange)
);

create index if not exists exchange_keys_user_idx on exchange_keys(user_id);

-- ---------------------------------------------------------------- позиции

create table if not exists positions (
  id               uuid primary key default gen_random_uuid(),
  user_id          bigint not null references users(id) on delete cascade,
  base             text not null,
  execution_mode   text not null default 'paper'
                   check (execution_mode in ('paper', 'testnet', 'live')),
  long_exchange    text not null,
  short_exchange   text not null,
  long_entry       double precision not null,
  short_entry      double precision not null,
  amount           double precision not null,
  leverage         integer not null default 1,
  target_spread    double precision,
  stop_spread      double precision,
  status           text not null default 'open' check (status in ('open', 'closed')),
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  exit_spread      double precision,
  realized_pnl     double precision,
  close_reason     text check (close_reason in ('manual', 'target', 'risk', 'timeout'))
);

create index if not exists positions_user_status_idx on positions(user_id, status);

-- ---------------------------------------------------------------- вотчлист

-- Монеты, отмеченные для торговли (чекбоксы в скринере). Лимит по тарифу
-- проверяет сервер при добавлении.
create table if not exists watchlist (
  user_id     bigint not null references users(id) on delete cascade,
  base        text not null,
  added_at    timestamptz not null default now(),
  primary key (user_id, base)
);

-- ---------------------------------------------------------------- сессии

-- Одна строка на устройство: платформа Telegram + версия клиента.
create table if not exists sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        bigint not null references users(id) on delete cascade,
  platform       text not null default 'unknown',
  tg_version     text not null default '',
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  unique (user_id, platform, tg_version)
);

-- ---------------------------------------------------------------- RLS

alter table users          enable row level security;
alter table user_settings  enable row level security;
alter table exchange_keys  enable row level security;
alter table positions      enable row level security;
alter table watchlist      enable row level security;
alter table sessions       enable row level security;
