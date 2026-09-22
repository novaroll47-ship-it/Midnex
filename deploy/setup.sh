#!/usr/bin/env bash
#
# Первичная настройка сервера — любой VPS с Ubuntu 22.04/24.04 или Debian 12
# (x86 или ARM). Запускать один раз на чистой машине из корня репозитория:
#
#   sudo DOMAIN=app.example.com TELEGRAM_BOT_TOKEN=... ADMIN_TELEGRAM_ID=... \
#        DATABASE_URL='postgresql://...' bash deploy/setup.sh
#
# Что делает: ставит Docker, открывает 80/443, создаёт deploy/.env (с ключом
# шифрования), собирает образ, применяет миграции, запускает три контейнера
# и ставит ежедневный бэкап SQLite в cron. Скрипт идемпотентен: повторный
# запуск ничего не ломает и существующий deploy/.env не трогает.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
	echo "Запусти через sudo: sudo DOMAIN=... TELEGRAM_BOT_TOKEN=... bash deploy/setup.sh" >&2
	exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy"

echo "==> 1/6 Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl

echo "==> 2/6 Docker"
if ! command -v docker >/dev/null 2>&1; then
	curl -fsSL https://get.docker.com | sh
else
	echo "    Docker уже установлен, пропускаю"
fi
systemctl enable --now docker

echo "==> 3/6 Своп"
# Сборка фронта и установка ccxt на 2 ГБ упираются в OOM; своп снимает проблему.
if [[ ! -f /swapfile ]] && (( $(free -m | awk '/^Mem:/{print $2}') < 5000 )); then
	fallocate -l 2G /swapfile
	chmod 600 /swapfile
	mkswap /swapfile >/dev/null
	swapon /swapfile
	echo '/swapfile none swap sw 0 0' >>/etc/fstab
	echo "    добавлен своп 2 ГБ"
else
	echo "    своп не нужен или уже есть"
fi

echo "==> 4/6 Порты 80 и 443"
# ufw — стандарт на Ubuntu/Debian-образах большинства хостеров. Если его нет
# (Oracle), открываем через iptables. Облачный firewall хостера открывается в
# его консоли — это отдельный уровень.
if command -v ufw >/dev/null 2>&1; then
	ufw allow OpenSSH >/dev/null
	ufw allow 80/tcp >/dev/null
	ufw allow 443/tcp >/dev/null
	ufw allow 443/udp >/dev/null
	ufw --force enable >/dev/null
	echo "    ufw: открыты SSH, 80, 443"
else
	for port in 80 443; do
		iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
	done
	apt-get install -y -qq iptables-persistent >/dev/null && netfilter-persistent save >/dev/null || true
	echo "    iptables: открыты 80, 443"
fi

echo "==> 5/6 Конфигурация"
if [[ ! -f "$DEPLOY_DIR/.env" ]]; then
	if [[ -z "${DOMAIN:-}" ]]; then
		# sslip.io резолвит 1-2-3-4.sslip.io в 1.2.3.4 — постоянное имя под
		# сертификат без покупки домена.
		PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org)"
		DOMAIN="${PUBLIC_IP//./-}.sslip.io"
		echo "    DOMAIN не задан — использую $DOMAIN"
	fi
	if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
		read -rsp "Токен бота от @BotFather: " TELEGRAM_BOT_TOKEN
		echo
	fi
	if [[ -z "${ADMIN_TELEGRAM_ID:-}" ]]; then
		read -rp "Telegram ID администратора (команда /id в боте): " ADMIN_TELEGRAM_ID
	fi
	if [[ -z "${DATABASE_URL:-}" ]]; then
		read -rp "DATABASE_URL (Supabase pooler, порт 6543): " DATABASE_URL
	fi
	# Ключ шифрования API-ключей бирж рождается здесь и живёт только на сервере.
	# Потерять его — значит потерять все сохранённые ключи, поэтому deploy/.env
	# стоит забэкапить. Переносишь приложение на другой сервер — переноси и его.
	KEY_ENCRYPTION_KEY="${KEY_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
	CRYPTOPAY_WEBHOOK_SECRET="${CRYPTOPAY_WEBHOOK_SECRET:-$(openssl rand -hex 16)}"
	umask 077
	sed -e "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" \
		-e "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN|" \
		-e "s|^ADMIN_TELEGRAM_ID=.*|ADMIN_TELEGRAM_ID=$ADMIN_TELEGRAM_ID|" \
		-e "s|^DATABASE_URL=.*|DATABASE_URL=$DATABASE_URL|" \
		-e "s|^KEY_ENCRYPTION_KEY=.*|KEY_ENCRYPTION_KEY=$KEY_ENCRYPTION_KEY|" \
		-e "s|^CRYPTOPAY_TOKEN=.*|CRYPTOPAY_TOKEN=${CRYPTOPAY_TOKEN:-}|" \
		-e "s|^CRYPTOPAY_WEBHOOK_SECRET=.*|CRYPTOPAY_WEBHOOK_SECRET=$CRYPTOPAY_WEBHOOK_SECRET|" \
		-e "s|^MARKET_WORKERS=.*|MARKET_WORKERS=${MARKET_WORKERS:-4}|" \
		"$DEPLOY_DIR/.env.example" >"$DEPLOY_DIR/.env"
	echo "    создан deploy/.env"
else
	echo "    deploy/.env уже есть, не трогаю"
	DOMAIN="$(grep -E '^DOMAIN=' "$DEPLOY_DIR/.env" | cut -d= -f2-)"
fi

echo "==> 6/6 Сборка, миграции, запуск"
cd "$DEPLOY_DIR"
docker compose build app
docker compose run --rm --no-deps app node apps/api/dist/scripts/migrate.js
docker compose up -d

# Ежедневная копия SQLite в 04:10 по времени сервера (7 последних копий на томе).
CRON_LINE="10 4 * * * cd $REPO_ROOT && bash deploy/backup.sh >>/var/log/midnex-backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'deploy/backup.sh' ; echo "$CRON_LINE" ) | crontab -

echo
echo "Готово. Приложение: https://$DOMAIN"
echo
echo "Сертификат выпускается около минуты после первого запуска. Бот сам"
echo "привяжет кнопку меню к этому адресу."
echo
echo "Проверить: curl https://$DOMAIN/api/health"
echo "Логи:      cd $DEPLOY_DIR && docker compose logs -f app"
echo
echo "Сохрани копию $DEPLOY_DIR/.env — в нём KEY_ENCRYPTION_KEY."
