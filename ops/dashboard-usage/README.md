# Dashboard usage journal

`/admin/dashboard-usage` is restricted to persisted `admin`, `admintop` and `top`
identities. Viewing a report does not grant access to this journal. The agreed
retention is one calendar month back from the current Moscow time, not 30 days.
Older events disappear from the list immediately; physical deletion requires the
independent retention timer described below. Application backups have their own
policy and are not rewritten by this job.

The additive `dashboard_usage_events` table is independent of HTML/data rollback
pairs. Events do not cascade-delete when an employee, report or old snapshot is
removed. The API derives actor identity from the current persisted session and
rechecks the report grant on each batch. Events are received in batches of at most
20 / 8 KiB, rate-limited per actor and deduplicated by actor + random event ID.
Dates are server receipt times, shown in Moscow time; no claimed client time is
treated as authoritative.

The parent hook pins an exact iframe window, origin and per-instance nonce. The
same-origin wrapper relays only allowlisted action/metadata from its exact opaque
child. Passwords, input values, filter selections, local paths and raw files are
never included. Successful supported imports can supply a basename (at most 255
characters) and byte size. Financial details use the separate reviewed V19 adapter.
HTML scripts cannot choose employee IDs or arbitrary API endpoints through this
bridge. Reports remain functional if logging is unavailable; logging is not proof
of employee productivity or a cryptographic financial audit.

## Delivery and employee summary

The admin layout fixes the current persisted session ID when it renders. Ordinary
event POSTs require that exact session scope; a changed session is rejected before
any write, not rebound to another user. The in-memory queue survives report
remounts, retains event IDs until acknowledgement and retries network/5xx/429
failures with capped exponential backoff and Retry-After. Requests have a 10-second
deadline. The queue holds at most 500 validated events, sends at most 20/8KiB per
request, and shows delivery failures/overflow instead of claiming success.
No events or financial metadata are persisted in browser storage. A hard page
close/crash can still lose unacknowledged events; a pending-queue navigation warning
and final keepalive attempt reduce this risk but are not a durable offline outbox.

`GET /api/admin/dashboard-usage?view=employees` lists active employee accounts,
including those without events, with name search and keyset pagination (50/page).
It separates the last opening, last event and last real interaction. Selecting an
employee opens `?view=employee&actor=...` report totals and the filtered event list.
Both summaries exclude preview/archive events and apply the same monthly cutoff.
The names/sizes of successfully uploaded files are visible in event details.

Visible report time is collected by the parent, not supplied by HTML: the browser
tab must be visible and the report iframe must intersect the viewport. Pulses are
normally 15 seconds, capped at 60 after a suspension, and flush on visibility or
report changes. Simultaneously visible reports share a pulse-window ID; employee
totals take the maximum interval per window rather than doubling a paired screen.
Per-report totals retain each report's own visible interval. This is not active
work time, and historical viewing durations cannot be reconstructed. Concurrent
independent browser tabs/devices are not globally deduplicated.

## Supported actions

- `report_open`: successful bridge handshake, once per viewing instance.
- `tab_changed`: trusted interaction with semantic tab/navigation elements.
- `filter_changed`: trusted change in recognised filter controls, without values.
- `calculation_completed`: explicit completion callback; never inferred from a
  generic button click, DOM mutations or a background render. The reviewed currency
  report emits it after the user-selected month's summary is calculated.
- `data_loaded`: explicit data-ready callback or a supported, successful adapter
  boundary (shared planner parsed/loaded, personal decrypted/applied, currency
  snapshot applied, TOP confirmed ready). Generic input delivery alone is not a
  successful load.
- `export_started`: validated export Blob prepared/requested or browser download
  initiated. This is **not** a guarantee the user saved the file to disk.
- `file_uploaded`: server-only event after an HTML/data/personal snapshot upload
  is successfully persisted. Client POST and iframe messages cannot emit it.
  A short bounded same-ID server retry never turns an already-saved file into a
  false upload failure; an exhausted audit write is logged separately.
- `viewing_time`: parent-only visible interval, hidden from the ordinary event
  list unless explicitly selected. Included in the employee/report summaries.

`report_open`, automatic `data_loaded`, and time pulses are not active-interaction
events. A successful user file import with validated filename metadata is counted
as an interaction. Auto-switching tabs and synthetic DOM changes are excluded.
Preview/archive mode is tagged separately. No continuous mouse/keyboard tracking
or input contents are recorded.

The current reviewed application-script fingerprints cover sales V98 (including
the climate variant), assortment V96, purchasing V55, strategy V24, personal
sales V34, route planner V26 and profitability V19. Their trusted tab/filter
intent and successful processing boundaries are explicit; failure/cancellation
does not count as completed calculation. A future changed application fingerprint
keeps the generic bridge but must be reviewed for semantic completion hooks.

## Contract for HTML authors

Existing reports need semantic markers/adapters; no platform can safely infer
successful calculations from arbitrary JavaScript or button captions.

For tabs use `role="tab"` / `data-tab` / `data-page`; for filter inputs add
`data-kts-usage-filter` (never add it to a password or manual financial form).
After successful processing, without including input data:

```js
window.dispatchEvent(new CustomEvent('kts:dashboard-usage', {
  detail: { action: 'calculation_completed' }
}));
```

Only client semantic actions are available to HTML (not `file_uploaded` or
`viewing_time`). Do not emit completion on validation
errors, cancellation, failed promises or timers. Interactive callbacks require a
recent trusted user interaction. The supplied HTML controls its own callbacks,
so this journal is not a cryptographic attestation of business results. Detailed
invoice auditing uses a separate, reviewed V19 adapter described below; it must
never be inferred from ordinary file selection or arbitrary financial forms.

## Monthly retention and deployment

The POST-only `/api/cron/dashboard-usage` endpoint requires its own
`DASHBOARD_USAGE_CRON_SECRET` (32–512 characters), accepts no body and calculates
the cutoff itself. It cannot select another table, employee, report or date.
One transaction deletes at most 10 batches of 1,000 expired usage events using
the `(created_at,id)` index. A non-blocking advisory lock excludes concurrent jobs;
SQL lock/statement timeouts bound contention. Associated invoice, filename and
visible-time detail rows are removed with their expired usage event through foreign
keys. No report HTML versions,
snapshots, employees or security audit are deleted. If a backlog
exceeds 10,000 entries, subsequent runs continue clearing it.

The same authenticated maintenance call independently drains the Knowledge Base
file-deletion outbox: at most 25 files and a 5-second admission budget per run.
Only a prior, explicit permanent deletion confirmed by Admin, Admin TOP or TOP
creates these jobs. There is no directory scan, archive expiry, orphan cleanup or
automatic deletion of existing materials. A job checks the deleted node, absence
of live references, private path, file size and digest before unlinking; it keeps
the receipt until the filesystem result is acknowledged. Usage history and the
deletion audit remain in the database. The two maintenance tasks run independently;
a journal failure does not prevent file cleanup, and pending file cleanup does not
turn an already committed user deletion into an error.

Cleanup uses bounded exponential retries (8 attempts, up to 1 hour between
attempts). Sanitized `knowledge_base_deletion_cleanup_pending` logs and the
`knowledgeBaseCleanup` scheduler summary distinguish pending work from exhausted
jobs. Inspect only the relevant receipts when troubleshooting:

```sql
SELECT node_id, deletion_id, attempts, next_attempt_at, failed_at, last_error
FROM knowledge_base_file_deletions
WHERE completed_at IS NULL
ORDER BY next_attempt_at, node_id
LIMIT 100;
```

After diagnosing and correcting the underlying storage problem, an operator may
explicitly requeue the exact confirmed job, in a transaction, by its verified
`node_id` and `deletion_id`: set `attempts=0`, `failed_at=NULL`,
`next_attempt_at=clock_timestamp()` and `last_error=NULL`, restricted to
`completed_at IS NULL AND failed_at IS NOT NULL`. Do not reset all jobs, bypass
the path/hash/reference checks, or manually delete files by a directory glob.
Missing files after a previous successful unlink are acknowledged idempotently.
An unavailable storage directory is not treated as a successfully removed file.

After the first permanent Knowledge Base deletion, a rollback to a release that
does not understand `deleted_at` may display deleted rows in its archive. The
database prevents their restoration and every deleted descendant has an archive
marker, so legacy file reads remain denied. Keep the additive migration in place;
use a compatible release for the normal interface rather than clearing deletion
flags or attempting to restore through an older application.

`kts-dashboard-usage.timer` runs every 15 minutes, independently of browsers and
the currency scheduler. `Persistent=true` catches up after server downtime. The
caller uses the loopback endpoint, refuses redirects and logs only deletion
counts/status, never event contents or secrets. The installer preserves unrelated
env bytes, reuses an existing matching secret, checks private permissions and
symlink targets, and backs up replaced files to private
`~/.local/state/kts-dashboard-usage/backups/install-*` directories. Backups can
contain application secrets: never attach or publish them.

The normal `deploy.yml` artifact includes the installer, units and caller. It
checks `/usr/bin/node`, user systemd and existing lingering without changing host
policy. After the pre-deployment backup succeeds, it installs the secret and units
**before** starting the new application. Only after readiness and all PM2 workers
converge does it run the first purge and enable/verify the timer. A scheduler
failure at that point fails the deployment visibly but leaves the already healthy
application running, without an unrelated restart or rollback.

Local preparation alone does not enable production retention. Confirm the timer
after the next authorized deployment. For a separately authorized manual setup,
run as the same unprivileged user as the application, against its real env file
(not a release symlink):

```sh
node ops/dashboard-usage/install.mjs --app-env /home/kts/kts-next-admin/.env.local --dry-run
node ops/dashboard-usage/install.mjs --app-env /home/kts/kts-next-admin/.env.local --apply
```

The installer does not reload the application or start services. Reload the
reviewed application release so it receives the new secret, then:

```sh
systemctl --user daemon-reload
systemctl --user start kts-dashboard-usage.service
systemctl --user enable --now kts-dashboard-usage.timer
systemctl --user is-active kts-dashboard-usage.timer
systemctl --user list-timers kts-dashboard-usage.timer
journalctl --user -u kts-dashboard-usage.service -n 20 --no-pager
```

If preflight reports missing lingering, stop and arrange explicit host
configuration; the installer/workflow does not run privileged `loginctl` commands.

## Reviewed invoice audit

The supplied profitability V19 has a separate application-script fingerprint and
adapter. After a successful user-initiated invoice/quote or local invoice snapshot
import, it submits invoice number, original item names and quantities, source deal
amount and currency. The server derives the employee and receipt time, rechecks
the session/report/version, and atomically stores the event and its details.
Identical retries retain their event ID. Unacknowledged imports show a visible
warning and guard navigation. Missing parsed numbers or amounts are explicit;
filenames are not represented as invoice numbers. Manual edits, demo data and
automatic restore do not count as an original invoice import.

The journal exposes details only to its existing reviewer roles. No raw invoice
files, passwords, arbitrary form values or bank details are captured. A changed
profitability application must be reviewed before enabling its import adapter;
there is no generic invoice extraction. Deploying the journal code does not
publish a profitability report or grant anyone access to one. Publication and
audience selection are separate operations.

## Verification

`node --import tsx --test tests/dashboard-usage.test.ts tests/dashboard-usage-cron.test.ts tests/dashboard-usage-install.test.ts`

`node --import tsx tests/dashboard-usage.browser.integration.ts`

`node --import tsx tests/dashboard-usage-delivery.browser.integration.ts`

`node --import tsx tests/dashboard-usage-journal.browser.integration.ts`

`KTS_TEST_PG_BIN=/path/to/postgresql/bin bash scripts/test-dashboard-usage-postgres.sh`

The PostgreSQL fixture creates and removes a dedicated temporary cluster with
synthetic users/reports only. It checks actor-scoped idempotency, revoked view and
preview permissions, server timestamps, keyset pagination, rate limiting and
independence from employee/report deletion and bounded calendar-month physical
retention. It never uses the ambient database URL.

The browser fixture uses isolated synthetic content and blocks external requests;
it exercises Chromium/WebKit opaque-frame handshakes and checks that field values
never cross into the event payload.
