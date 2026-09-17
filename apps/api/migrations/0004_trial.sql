-- Пробная неделя: один раз на Telegram-аккаунт.
alter table users add column if not exists trial_used_at timestamptz;
