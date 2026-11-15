# Учёт посещений портфолио

Cloudflare Worker + KV. Страница портфолио при открытии шлёт `POST /hit`, воркер записывает
IP (`CF-Connecting-IP`), время, страницу, referrer, user-agent и страну. Сводка — `GET /stats?key=<STATS_KEY>`:
таблица IP → число визитов → список дат (`&format=json` — то же в JSON).

Данные IP удаляются через `RETENTION_DAYS` (180) дней после последнего визита, на IP хранится до 200 визитов.

## Деплой (один раз)

Нужен бесплатный аккаунт Cloudflare.

```bash
cd tracker
npx wrangler login
npx wrangler kv namespace create VISITS   # id из вывода вписать в wrangler.toml
npx wrangler secret put STATS_KEY         # ввести длинный случайный пароль для сводки
npx wrangler deploy                       # выведет адрес https://portfolio-visits.<subdomain>.workers.dev
```

Затем в `index.html` вписать этот адрес в `TRACKER_URL` (без `/` в конце), закоммитить и смержить в `main`.

## Использование

- Сводка: `https://portfolio-visits.<subdomain>.workers.dev/stats?key=<STATS_KEY>`
- Не учитывать свои визиты: один раз открыть портфолио с `?notrack` (флаг в localStorage этого браузера), вернуть — `?track`.
