# KTS Next Admin

Production-приложение КТС на Next.js: публичный сайт и каталог, административная панель, B2B-прайсы и личный кабинет клиента.

## Возможности

- публичные страницы компании, каталог, новости, слайдер и портфель брендов;
- управление контентом, каталогом, пользователями и клиентами из админ-панели;
- создание B2B-прайсов, публичные ссылки, PDF/Excel-экспорт и аналитика;
- личный кабинет клиента с документами, заявками и чатом;
- поиск аналогов оборудования для менеджеров и в клиентских прайсах с учётом хладагента, холодопроизводительности и складского наличия;
- импорт каталога и складских остатков из Excel;
- автоматический импорт остатков из почтового ящика;
- PostgreSQL-хранилище, аудит безопасности, rate limiting и двухфакторная аутентификация.

## Стек

- Node.js 24 и npm;
- Next.js 16 (App Router, Turbopack, standalone output);
- React 19 и TypeScript в strict-режиме;
- PostgreSQL;
- SCSS Modules;
- PM2 и GitHub Actions для production-деплоя.

## Локальный запуск

Требования: Node.js 24, npm и доступная PostgreSQL-база для страниц, работающих с данными.

```bash
npm ci
npm run dev
```

Перед запуском создайте `.env.local` с нужными переменными. Файл с секретами не коммитить. Приложение будет доступно на [http://localhost:3000](http://localhost:3000).

Минимальный production-like env:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/kts
ADMIN_SESSION_SECRET=replace-with-a-long-random-secret
ADMIN_PASSWORD=replace-with-a-strong-bootstrap-password

NEXT_PUBLIC_CMS_URL=
NEXT_PUBLIC_CMS_LOCALE=ru
```

`DATABASE_URL` обязателен для каталога, админ-панели, B2B-прайсов и кабинета клиента. `ADMIN_SESSION_SECRET` обязателен в production. `ADMIN_PASSWORD` используется как резервный административный вход и не должен совпадать с паролями пользователей.

### Дополнительные переменные окружения

| Переменная | Назначение |
| --- | --- |
| `ADMIN_COOKIE_SECURE` | Принудительный secure-флаг административной cookie |
| `ADMIN_2FA_ENABLED` | Включение двухфакторного входа по email |
| `ADMIN_2FA_EMAIL` | Резервный получатель кода 2FA |
| `UPLOAD_DIR` | Каталог для загруженных изображений и клиентских документов |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Параметры SMTP-сервера |
| `SMTP_USER`, `SMTP_PASSWORD` | Учётные данные SMTP |
| `SMTP_FROM`, `SMTP_TO` | Отправитель и получатель системных писем |
| `CRON_SECRET` | Bearer-токен для `/api/cron/stock-import` |
| `PDF_CACHE_MAX_AGE_DAYS` | Срок хранения PDF-кэша для maintenance-скрипта |
| `STOCK_MAIL_*` | Настройки импорта остатков из почты |

Полный набор `STOCK_MAIL_*` и формат Excel описаны в [docs/stock-email-import.md](docs/stock-email-import.md).

## Команды

| Команда | Назначение |
| --- | --- |
| `npm run dev` | Локальный сервер разработки |
| `npm run build` | Production-сборка Next.js через Turbopack |
| `npm run build:webpack` | Резервная webpack-сборка для диагностики |
| `npm start` | Локальный запуск собранного приложения; VPS запускает standalone `server.js` через PM2 |
| `npm run lint` | ESLint |
| `npm test` | Unit/regression-тесты через Node test runner |
| `npm run analogs:generate -- --source-dir <папка>` | Пересборка базы аналогов из пяти исходных Excel-файлов |
| `npm run cleanup` | Очистка устаревших сессий, событий и PDF-кэша |
| `npm run stock:import-email` | Ручной импорт складских остатков из почты |

Перед отправкой изменений:

```bash
npm run lint
npm test
npx tsc --noEmit --incremental false
npm audit --omit=dev --audit-level=high
npm run build
```

## Структура

```text
src/app/       маршруты App Router и API
src/entities/  модели и доступ к данным доменных сущностей
src/features/  административные и клиентские сценарии
src/shared/    БД, безопасность, общие библиотеки и UI
src/widgets/   составные блоки публичных страниц
scripts/       maintenance, backup и импорт
tests/         unit/regression-тесты
docs/          эксплуатационная документация
public/        статические файлы и загружаемые ресурсы
```

## База данных и файлы

Схема и миграции применяются приложением через слой `src/shared/lib/db`. Перед изменениями production-базы сделайте резервную копию. Инструкция по backup и проверке восстановления находится в [docs/postgres-backup.md](docs/postgres-backup.md).

В production загружаемые файлы хранятся вне release-каталога и подключаются в активный релиз символьными ссылками. Не добавляйте пользовательские загрузки, дампы БД и `.env*` в Git.

Нормализованная база аналогов хранится в `src/shared/data/analogs.generated.json`. Исходные Excel-файлы не нужно коммитить: для обновления укажите папку через `--source-dir` или `ANALOGS_SOURCE_DIR`, проверьте diff сгенерированного JSON и запустите тесты.

## Деплой

Workflow `.github/workflows/deploy.yml` запускается при push в `main` или вручную. Он:

1. устанавливает зависимости через `npm ci`;
2. запускает ESLint, тесты, TypeScript и production dependency audit;
3. собирает standalone-приложение;
4. загружает release-архив на VPS;
5. переключает символьную ссылку текущего релиза и перезапускает приложение через PM2;
6. проверяет HTTP-ответ на локальном порту `3000`.

Production-секреты и `.env.local` хранятся на VPS/GitHub, а не в репозитории.
