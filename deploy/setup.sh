#!/usr/bin/env bash
#
# Первичная настройка сервера Oracle Cloud (Ubuntu 22.04/24.04, ARM Ampere).
# Запускать один раз на чистой машине:
#
#   sudo TELEGRAM_BOT_TOKEN=<токен> bash deploy/setup.sh
#
# Скрипт идемпотентен: повторный запуск ничего не ломает.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
	echo "Запусти через sudo: sudo TELEGRAM_BOT_TOKEN=... bash deploy/setup.sh" >&2
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
	umask 077
	cat >"$DEPLOY_DIR/.env" <<EOF
DOMAIN=$DOMAIN
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
WEB_ORIGIN=https://$DOMAIN
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
echo "Осталось привязать его к боту (подставь свой токен):"
echo "  curl -X POST \"https://api.telegram.org/bot<ТОКЕН>/setChatMenuButton\" \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"menu_button\":{\"type\":\"web_app\",\"text\":\"MIDNEX\",\"web_app\":{\"url\":\"https://$DOMAIN\"}}}'"
echo
echo "Проверить: curl https://$DOMAIN/api/health"
echo "Логи:      cd $DEPLOY_DIR && docker compose logs -f"
