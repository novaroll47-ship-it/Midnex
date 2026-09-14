-- Служебные настройки приложения (ключ-значение).
-- public_url — текущий внешний адрес приложения; его читает edge-функция
-- `app`, дающая постоянный адрес поверх временного туннеля (deploy/supabase).
create table if not exists app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table app_config enable row level security;
