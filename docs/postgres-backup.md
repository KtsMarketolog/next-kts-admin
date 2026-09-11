# KTS backup and restore

The current runbook is [ops/backup/README.md](../ops/backup/README.md).
Independent monitoring and email setup are in [MONITORING.md](../ops/backup/MONITORING.md).

Retention agreed on 2026-09-12: **14 days locally, 5 days in Yandex Object Storage**.
This covers PostgreSQL, inventoried persistent files and recovery configuration,
not a whole-server image.

Do not install the former example cron or pass DATABASE_URL on the command line.
The old generic `/home/deploy/...` paths did not describe the production KTS server.
`scripts/db-backup.sh` delegates to the installed locked local-capture command.
`scripts/db-restore-check.sh` no longer accepts a dump path or RESTORE_DATABASE_URL;
it downloads from the configured cloud and invokes the isolated systemd restore.
Both compatibility scripts run as `kts` on the audited server.

Cloud commissioning, GitHub SMTP secrets and activation remain subject to the
acceptance checklist in the runbook. Never restore a test over production.
