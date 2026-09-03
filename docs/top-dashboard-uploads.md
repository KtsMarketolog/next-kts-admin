# Большие файлы данных TOP-дашбордов

Публичный предел потоковой загрузки данных — 500 МиБ. Приложение принимает такой
запрос через `stream-v1` и сразу пишет его в защищённое файловое хранилище. Один
процесс не держит весь файл в памяти.

У старого multipart-режима отдельный предел 100 МиБ, а у распакованного JSON в
gzip — 2 ГиБ. `experimental.proxyClientMaxBodySize` в `next.config.ts` следует
оставлять равным `101mb`: повышение этого значения заставит Next.js буферизовать
слишком большие запросы в памяти.

На Nginx увеличенный предел должен действовать только для маршрута загрузки:

```nginx
location ~ ^/api/admin/top-dashboard/blocks/[1-9][0-9]*/data/?$ {
    client_max_body_size 501m;
    client_body_timeout 10m;

    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_request_buffering off;
    proxy_read_timeout 10m;
    proxy_send_timeout 10m;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`501m` оставляет место для служебного контейнера вокруг файла размером до
500 МиБ. Общий предел виртуального хоста можно оставить низким для остальных
маршрутов.

История данных ограничена примерно 1,5 ГиБ на каждый блок: активная версия,
версия для отката и ещё один максимальный снимок. Во время замены временно может
потребоваться около 2 ГиБ свободного места на блок. Следите также за суммарным
свободным местом, если блоков станет много.

После изменения конфигурации обязательно выполнить `sudo nginx -t` и только
после успешной проверки — `sudo systemctl reload nginx`.

Для production-конфига проекта есть идемпотентный helper с резервной копией и
автоматическим откатом при ошибке:

```bash
sudo sh ops/apply-top-dashboard-nginx-limit.sh
```
