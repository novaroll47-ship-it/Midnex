#!/usr/bin/env bash
#
# Выкатить новую версию на сервер:
#
#   bash deploy/update.sh
#
# Забирает код из git, собирает образ (старый контейнер работает всё это
# время), снимает копию SQLite, применяет миграции, перезапускает приложение
# и проверяет /api/health. Простой — секунды на перезапуск контейнера.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Обновляю код"
git pull --ff-only

cd deploy

echo "==> Собираю образ"
docker compose build app

echo "==> Копия истории (SQLite)"
docker compose exec -T app node apps/api/dist/scripts/history-maintenance.js backup || echo "    приложение не запущено — копию пропускаю"

echo "==> Миграции"
docker compose run --rm --no-deps app node apps/api/dist/scripts/migrate.js

echo "==> Перезапускаю"
docker compose up -d

echo "==> Убираю старые образы"
docker image prune -f >/dev/null

DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2-)"
echo "==> Жду приложение"
for i in $(seq 1 30); do
	if curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/tmp/midnex-health.json 2>/dev/null; then
		echo "    ок: $(head -c 160 /tmp/midnex-health.json)"
		exit 0
	fi
	sleep 3
done
echo "    приложение не ответило за 90 с — смотри: docker compose logs --tail=100 app" >&2
exit 1
