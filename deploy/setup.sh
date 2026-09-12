#!/usr/bin/env bash
#
# Первичная настройка сервера Oracle Cloud (Ubuntu 22.04/24.04, ARM Ampere).
# Запускать один раз на чистой машине:
#
#   sudo TELEGRAM_BOT_TOKEN=<токен> DATABASE_URL=<строка Supabase> bash deploy/setup.sh
#
# Скрипт идемпотентен: повторный запуск ничего не ломает.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
	echo "Запусти через sudo: sudo TELEGRAM_BOT_TOKEN=... DATABASE_URL=... bash deploy/setup.sh" >&2
	exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy"

echo "==> 1/5 Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git iptables-persistent

echo "==> 2/5 Docker"
if ! command -v docker >/dev/null 2>&1; then
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
		>/etc/apt/sources.list.d/docker.list
	apt-get update -qq
	apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
	echo "    Docker уже установлен, пропускаю"
fi
systemctl enable --now docker

echo "==> 3/5 Порты 80 и 443"
# В образах Ubuntu от Oracle iptables по умолчанию пропускает только SSH,
# и это отдельный от консольных Security Lists уровень. Открыть нужно оба,
# иначе Let's Encrypt не сможет подтвердить домен и сертификата не будет.
for port in 80 443; do
	if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
		iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
		echo "    открыт $port"
	else
		echo "    $port уже открыт"
	fi
done
netfilter-persistent save >/dev/null

echo "==> 4/5 Конфигурация"
# sslip.io резолвит 1-2-3-4.sslip.io в 1.2.3.4 — это даёт постоянный адрес
# под сертификат, не покупая домен.
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org)"
DOMAIN="${PUBLIC_IP//./-}.sslip.io"

if [[ ! -f "$DEPLOY_DIR/.env" ]]; then
	if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
		read -rsp "Токен бота от @BotFather: " TELEGRAM_BOT_TOKEN
		echo
	fi
	if [[ -z "${DATABASE_URL:-}" ]]; then
		read -rp "DATABASE_URL (Supabase pooler, пусто = хранить в памяти): " DATABASE_URL
	fi
	# Ключ шифрования API-ключей бирж рождается здесь и живёт только на сервере.
	# Потерять его — значит потерять все сохранённые ключи, поэтому deploy/.env
	# стоит забэкапить. Переносишь приложение на другой сервер — переноси и его.
	KEY_ENCRYPTION_KEY="${KEY_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
	umask 077
	cat >"$DEPLOY_DIR/.env" <<EOF
DOMAIN=$DOMAIN
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
WEB_ORIGIN=https://$DOMAIN
DATABASE_URL=$DATABASE_URL
KEY_ENCRYPTION_KEY=$KEY_ENCRYPTION_KEY
MARKET_MODE=live
EOF
	echo "    создан deploy/.env"
else
	echo "    deploy/.env уже есть, не трогаю"
	DOMAIN="$(grep -E '^DOMAIN=' "$DEPLOY_DIR/.env" | cut -d= -f2-)"
fi

echo "==> 5/5 Сборка и запуск"
cd "$DEPLOY_DIR"
docker compose up -d --build

echo
echo "Готово. Приложение: https://$DOMAIN"
echo
echo "Сертификат выпускается около минуты после первого запуска. Бот сам"
echo "привяжет кнопку меню к этому адресу — ничего вручную делать не нужно."
echo
echo "Проверить: curl https://$DOMAIN/api/health"
echo "Логи:      cd $DEPLOY_DIR && docker compose logs -f"
