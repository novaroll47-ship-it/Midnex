-- Какие боты торгуют отмеченную монету. По умолчанию — все; пустой набор
-- не хранится (монета просто убирается из списка).
alter table watchlist add column if not exists bots text[] not null default '{spread,funding}';
