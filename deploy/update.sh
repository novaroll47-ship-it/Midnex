#!/usr/bin/env bash
#
# Выкатить новую версию на сервер:
#
#   bash deploy/update.sh
#
# Забирает свежий код из git, пересобирает образ и перезапускает контейнер.
# Простой на время пересборки — несколько секунд.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Обновляю код"
git pull --ff-only

echo "==> Пересобираю и перезапускаю"
cd deploy
docker compose up -d --build

echo "==> Убираю старые образы"
docker image prune -f >/dev/null

DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2-)"
echo
echo "Проверка:"
curl -fsS "https://$DOMAIN/api/health" && echo
