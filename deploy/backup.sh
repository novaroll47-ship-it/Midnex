#!/usr/bin/env bash
#
# Резервная копия данных приложения. Ставится в cron скриптом setup.sh
# (ежедневно 04:10), можно запускать руками: bash deploy/backup.sh
#
# Что копируется:
# - SQLite с историей спредов — онлайн-копия внутри тома /data/backups
#   (7 последних), плюс последняя копия выгружается в BACKUP_DIR на хосте;
# - deploy/.env (токены и ключ шифрования) — в BACKUP_DIR.
# Пользователи, подписки, оплаты и партнёрка живут в Supabase — у него свои
# бэкапы. VictoriaMetrics хранит 7 дней посекундных точек и не бэкапится.
#
# Копии на этом же сервере не спасают от потери сервера: раз в неделю
# забирай BACKUP_DIR к себе (scp/rclone) или укажи BACKUP_REMOTE для rclone.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/midnex}"
mkdir -p "$BACKUP_DIR"
cd "$REPO_ROOT/deploy"

echo "[$(date -Is)] копия SQLite"
docker compose exec -T app node apps/api/dist/scripts/history-maintenance.js backup

# Последняя копия — на хост, чтобы её можно было забрать без docker.
LATEST="$(docker compose exec -T app sh -c 'ls -1 /data/backups/history-*.sqlite | tail -n 1')"
docker compose cp "app:${LATEST}" "$BACKUP_DIR/history-latest.sqlite"
cp -f .env "$BACKUP_DIR/deploy.env"
chmod 600 "$BACKUP_DIR/deploy.env"

if [[ -n "${BACKUP_REMOTE:-}" ]] && command -v rclone >/dev/null 2>&1; then
	rclone copy "$BACKUP_DIR" "$BACKUP_REMOTE" --quiet
	echo "[$(date -Is)] выгружено в $BACKUP_REMOTE"
fi
echo "[$(date -Is)] готово: $BACKUP_DIR"
