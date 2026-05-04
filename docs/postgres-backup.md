# Postgres Backup And Restore Check

Production backup:

```bash
cd /home/deploy/apps/PROJECT/current
export DATABASE_URL='postgres://...'
BACKUP_DIR=/home/deploy/backups/kts ./scripts/db-backup.sh
```

Restore check on a disposable test database:

```bash
export RESTORE_DATABASE_URL='postgres://.../kts_restore_check'
./scripts/db-restore-check.sh /home/deploy/backups/kts/kts-YYYYMMDD-HHMMSS.dump
```

Recommended cron cadence:

```cron
15 3 * * * cd /home/deploy/apps/PROJECT/current && BACKUP_DIR=/home/deploy/backups/kts ./scripts/db-backup.sh >> /home/deploy/backups/kts/backup.log 2>&1
```

Keep backup files outside the app directory and outside git. Periodically run the restore check; a backup that has never been restored is not proven useful.
