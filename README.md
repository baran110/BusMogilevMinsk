# ММ — маршрутки Могилёв ↔ Минск

Адаптивное русскоязычное PWA для сравнения маршруток и регулярных автобусов между Могилёвом и Минском. Сервис не продаёт билеты: каждая карточка ведёт на сайт перевозчика или официальную площадку бронирования.

## Что реализовано

- оба направления, календарь на 30 дней, автоматическое скрытие прошедших рейсов;
- фильтры по времени, цене, перевозчику, остановкам, наличию мест и типу транспорта;
- сортировка по времени, цене и длительности;
- реальные адаптеры открытого API `avto-slava.by` и `mogilevminsk.by`;
- браузерный адаптер Atlas и изолированные проверки GrandExpress/TicketBus;
- точное удаление дублей с сохранением альтернативных каналов бронирования;
- Pages Function `/api/trips`, версионные снимки Workers KV и CDN-кэш на 5 минут;
- ежечасный GitHub Actions collector, PWA и responsive UI для Android/ПК;
- резерв последнего успешного снимка до 24 часов.

## Локальный запуск

Требуются Node.js 22+ и pnpm 11.

```bash
pnpm install
pnpm dev
```

Без локального Pages API интерфейс автоматически включает демонстрационный набор, помеченный соответствующим уведомлением. Для проверки реального сборщика:

```bash
pnpm exec playwright install chromium
pnpm collect:sample
```

Снимок будет записан в `data/snapshots/sample.json`.

## Cloudflare Pages и KV

1. Создайте публичный GitHub-репозиторий и отправьте код в ветку `main`.
2. В Cloudflare создайте Workers KV namespace, например `bus-trips`.
3. Создайте Pages-проект из GitHub: build command `pnpm build`, output directory `dist`.
4. В Pages → Settings → Bindings добавьте KV binding с именем `TRIPS_KV`.
5. Создайте API token Cloudflare с правом записи Workers KV.
6. В GitHub → Settings → Secrets and variables → Actions добавьте:
   - `CLOUDFLARE_API_TOKEN`;
   - `CLOUDFLARE_ACCOUNT_ID`;
   - `KV_NAMESPACE_ID`.
7. Запустите workflow «Обновление расписания» вручную. Далее он работает каждый час на 17-й минуте.

Сборщик сначала загружает два версионных ключа направления с TTL 48 часов, затем переключает `manifest:active`. Поэтому пользователь никогда не увидит наполовину записанный снимок. `_routes.json` вызывает Functions только для `/api/*`; статические файлы Pages остаются вне квоты Functions.

## API

```http
GET /api/trips?direction=mogilev-minsk&date=2026-07-13
GET /api/trips?direction=minsk-mogilev&date=2026-07-13
```

Успешный ответ содержит `trips`, `sources`, `generatedAt` и `stale`. Неправильные параметры возвращают `400`, отсутствующий или старше 24 часов снимок — `503`.

## Добавление источника

1. Добавьте источник в `data/sources.json` и перевозчиков в `data/carriers.json`.
2. Создайте адаптер в `scripts/sources/`, возвращающий `{ trips, health }`.
3. Сначала используйте документированный или публичный JSON/API; HTML и Playwright — только если структурированных данных нет.
4. Не обходите CAPTCHA, авторизацию, rate limit или запреты источника.
5. Добавьте контрактный тест с локальной фикстурой и подключите адаптер в `scripts/collect.ts`.

## Проверки

```bash
pnpm typecheck
pnpm test:run
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

E2E выполняются в профилях Pixel 5 и Desktop Chrome. Репозиторий не содержит админ-панели, пользовательских аккаунтов, оплаты или хранения персональных данных.
