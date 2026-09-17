alter table user_settings add column if not exists onboarding jsonb not null default '{}'::jsonb;
