-- Личные настройки вида (список/карточки в скринере).
alter table user_settings add column if not exists ui jsonb not null default '{}'::jsonb;
