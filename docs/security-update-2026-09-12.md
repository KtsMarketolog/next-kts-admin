# Security update — 12 сентября 2026

Обновление согласовано владельцем после остановки CI-деплоя `641844f` на npm audit.
Проверки безопасности не отключались; прикладные расчёты и схема БД не менялись.

| Компонент | Проверенная версия |
| --- | --- |
| Next.js / eslint-config-next | 16.3.5 |
| Sharp (зависимость Next.js) | 0.35.4 |
| Nodemailer | 9.1.1 |
| Mailparser | 3.9.20, использует тот же Nodemailer 9.1.1 |
| js-yaml (только инструменты разработки) | 4.3.2 |

Обновлён package-lock; лишние пакеты не обновлялись намеренно. Mailparser закреплён,
чтобы не оставить его старый вложенный Nodemailer и не переходить на Nodemailer 10.
Sharp обновлён через совместимый диапазон Next.js, без принудительного override.

## Локальная проверка

- `npm ci` — успешно.
- `npm audit` и `npm audit --omit=dev` — 0 уязвимостей.
- 135 тестов приложения и 63 теста резервного копирования — успешно.
- TypeScript — успешно; ESLint — 0 ошибок, 37 прежних предупреждений об img.
- Production webpack build — успешно, 49 статических страниц.
- Проверка Yandex verification meta в локальном артефакте — успешно с тестовым
  значением. Для настоящего релиза CI использует существующий repository secret.
- Sharp обработал небольшой тестовый SVG в PNG; Nodemailer создал тестовое MIME-
  письмо, Mailparser корректно разобрал его. Реальные письма этим smoke не отправлялись.
- Локальная сборка выполнялась с пустыми DATABASE_URL и APP_RELEASE_ID, без
  подключения к production и без запуска production-миграций.

Штатный CI повторяет проверки и сборку, затем требует свежую подтверждённую облаком
копию до запуска canary/миграций. Откат кода не является откатом схемы PostgreSQL.

## Production

[CI-деплой `23c47dc`](https://github.com/KtsMarketolog/next-kts-admin/actions/runs/34660870628)
завершён успешно 12.09.2026 00:16:47 UTC. Активен релиз
`20260912001458-23c47dc`, оба worker используют его; версии Next.js и Sharp
подтверждены на сервере. Главная и readiness отвечают HTTP 200.
Преддеплойная копия `kts-next-admin-20260912T001510Z-18bac135802c`
подтверждена в Yandex в 00:16:30 UTC до завершения активации.
Полная независимая проверка нового состояния — успешный run `34661491940`.

## Источники

- [Next.js: AVIF image optimization advisory](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4).
- [Sharp: libheif advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).
- [Nodemailer: recipient validation advisory](https://github.com/nodemailer/nodemailer/security/advisories/GHSA-cc9r-2j5m-2m83).
- Версии и integrity пакетов сверены с официальным npm registry.
