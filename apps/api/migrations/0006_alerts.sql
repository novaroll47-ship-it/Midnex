-- Пороговые алерты по спреду: по монете или общие; is_armed — гистерезис.
create table if not exists user_alert_rules (
  id             text primary key,
  user_id        bigint not null references users(id) on delete cascade,
  type           text not null,            -- pair | global
  base           text,                     -- монета; null для global
  threshold_pct  numeric not null,
  is_armed       boolean not null default true,
  last_fired_at  timestamptz,
  last_base      text,
  created_at     timestamptz not null default now()
);
create index if not exists user_alert_rules_user on user_alert_rules (user_id);
alter table user_alert_rules enable row level security;
