# Развёртывание на VPS

Цель — приложение и бот работают круглосуточно на сервере, а не на ПК.
После этих шагов у бота постоянный HTTPS-адрес, автоперезапуск, бэкапы и
обновление одной командой.

Что живёт на сервере: приложение (API + фронт + бот в одном процессе, ccxt в
worker-потоках), VictoriaMetrics (посекундный спред, 7 дней), Caddy (HTTPS).
Что остаётся снаружи: Supabase (пользователи, подписки, оплаты, партнёрка).

---

## 1. Сервер

| Параметр | Рекомендация |
| --- | --- |
| Память | **4 ГБ** (8 бирж в 4 потоках ≈ 1.5 ГБ + VictoriaMetrics ≈ 0.3 ГБ + запас). На 2 ГБ работает с `MARKET_WORKERS=2`. |
| CPU | 2 vCPU. Главный поток занят на 20–30 %, worker'ы разбирают WebSocket-потоки бирж. |
| Диск | 40 ГБ SSD. История SQLite ≈ 1 ГБ в год, VictoriaMetrics ≈ 0.2 ГБ, образы Docker ≈ 1.5 ГБ. |
| Регион | **Сингапур** или **Токио**: рядом серверы бирж и пулер Supabase (`ap-southeast-1`) — запрос к базе 2–5 мс вместо 200 из Европы. Франкфурт — приемлемо. |
| ОС | Ubuntu 24.04 LTS (или 22.04, Debian 12). |

Подходят Hetzner (CPX21/CPX31, есть Сингапур), Vultr, DigitalOcean, Contabo.
Перед покупкой на длинный срок проверь с сервера доступность бирж
(некоторые режут датацентровые IP по стране):

```bash
for u in https://fapi.binance.com/fapi/v1/time https://api.bybit.com/v5/market/time \
         https://www.okx.com/api/v5/public/time https://contract.mexc.com/api/v1/contract/ping \
         https://api.bitget.com/api/v2/public/time https://open-api.bingx.com/openApi/swap/v2/server/time \
         https://api.gateio.ws/api/v4/futures/usdt/contracts/BTC_USDT https://api-futures.kucoin.com/api/v1/timestamp; do
  printf '%-60s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$u")"; done
```

Все восемь должны ответить `200`.

## 2. Домен

Купи домен (или поддомен вида `app.midnex.io`) и направь **A-запись** на IP
сервера. Без домена можно временно жить на `1-2-3-4.sslip.io` — setup.sh
подставит его сам, когда `DOMAIN` не задан.

Если домен за Cloudflare — на время выпуска сертификата выключи «оранжевое
облако» (DNS only), иначе Let's Encrypt не подтвердит домен.

## 3. Развернуть

На сервере:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <адрес репозитория> midnex
cd midnex
sudo DOMAIN=app.example.com \
     TELEGRAM_BOT_TOKEN='<токен от @BotFather>' \
     ADMIN_TELEGRAM_ID=<твой Telegram ID> \
     DATABASE_URL='postgresql://postgres.<ref>:<пароль>@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres' \
     CRYPTOPAY_TOKEN='<токен приложения CryptoBot>' \
     bash deploy/setup.sh
```

Скрипт ставит Docker, открывает порты, создаёт `deploy/.env` (с ключом
шифрования и секретом вебхука), собирает образ, **применяет миграции**,
запускает три контейнера и ставит ежедневный бэкап в cron. 5–10 минут.

Дальше — руками, один раз:

1. **Supabase → `app_config.public_url`** = `https://<DOMAIN>`. Старые ссылки
   через `…supabase.co/functions/v1/app` продолжат работать редиректом.
2. **@BotFather → Bot Settings → Menu Button** — бот сам ставит кнопку на
   `PUBLIC_URL`, проверь, что открывается. Там же (Configure Mini App) можно
   включить Main Mini App на тот же адрес — тогда заработают прямые ссылки
   `t.me/<бот>?startapp=p_код`.
3. **@CryptoBot → Crypto Pay → приложение → Webhook** =
   `https://<DOMAIN>/api/cryptopay/webhook/<CRYPTOPAY_WEBHOOK_SECRET>`
   (секрет — из `deploy/.env`). Прежний адрес через Supabase-функцию
   `cryptopay` можно оставить: она тоже перенаправляет на `public_url`.
4. Внешний мониторинг: UptimeRobot / BetterStack на `https://<DOMAIN>/api/health`
   раз в минуту, оповещение в Telegram.
5. Скопируй `deploy/.env` к себе: там `KEY_ENCRYPTION_KEY`, без него не
   расшифровать ключи бирж пользователей.

## 4. Проверка после запуска

```bash
curl -s https://<DOMAIN>/api/health | python3 -m json.tool
```

Смотреть: `storage: "postgres"`, `encryption: true`, `books.fresh` ≈ 120,
`workers[*].heapUsedMb` — по 100–200 МБ, `eventLoopMs.p99` < 100.
В боте: `/admin` → меню, «Партнёры» открываются (значит, миграции на месте).
В приложении: лента живая, экран монеты — график и ликвидность.

## 5. Повседневное

| Задача | Команда |
| --- | --- |
| Обновить версию | `cd ~/midnex && bash deploy/update.sh` |
| Логи приложения | `cd ~/midnex/deploy && docker compose logs -f --tail=200 app` |
| Перезапустить | `cd ~/midnex/deploy && docker compose restart app` |
| Остановить всё | `cd ~/midnex/deploy && docker compose down` |
| Поменять настройку | правка `deploy/.env` → `docker compose up -d app` |
| Бэкап сейчас | `bash deploy/backup.sh` (копии: `/var/backups/midnex`) |
| Место в SQLite после чистки | `docker compose stop app && docker compose run --rm --no-deps app node apps/api/dist/scripts/history-maintenance.js vacuum && docker compose start app` |
| Профиль CPU | `CPU_PROFILE="60,30"` в `.env`, перезапуск, файл в `/data`… см. `apps/api/src/diag.ts` |

Откат: `git checkout <прошлый коммит> && bash deploy/update.sh` (миграции
вперёд-совместимы — таблицы не удаляются).

## 6. Память и потоки

`MARKET_WORKERS` — сколько потоков под ccxt (8 бирж раскладываются по
кругу). Каждый поток — ~80 МБ на сам ccxt плюс данные своих бирж; потолок
кучи — `MARKET_WORKER_HEAP_MB` (384). Итого:

| Память сервера | `MARKET_WORKERS` | `mem_limit` app |
| --- | --- | --- |
| 2 ГБ | 2 | 1.5g |
| 4 ГБ | 4 | 3g |
| 8 ГБ | 4 | 3g (больше не нужно) |

Если контейнер упирается в `mem_limit`, Docker перезапустит его — это видно
по `docker compose ps` (uptime) и в `/api/health → uptimeSec`.

## 7. Перенос с ПК

Историю спредов (SQLite) можно перенести, чтобы графики не начинались с
нуля: на ПК `stop.bat`, файл `.data/history.sqlite` (1–2 ГБ) — на сервер, там:

```bash
cd ~/midnex/deploy && docker compose stop app
docker compose cp history.sqlite app:/data/history.sqlite
docker compose exec -u root app chown node:node /data/history.sqlite
docker compose start app
```

Посекундные точки (VictoriaMetrics) не переносим — их 7 дней, накопятся сами.

## 8. Oracle Cloud Always Free

Бесплатный вариант: VM.Standard.A1.Flex (ARM, 2 OCPU / 12 ГБ) в Сингапуре
или Токио. Отличия от обычного VPS: порты 80/443 открываются **и** в
консоли (VCN → Security Lists → Ingress), и на машине (setup.sh делает
через iptables, ufw там нет). Образ собирается под ARM без изменений.
