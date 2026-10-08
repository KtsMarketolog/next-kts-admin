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
same-origin wrapper relays only an allowlisted action string from its exact opaque
child. Neither passwords, input values, filter selections, file names nor financial
payloads are included. HTML scripts cannot choose employee IDs or arbitrary API
endpoints through this bridge. Reports remain functional if logging is unavailable;
logging is best-effort, not a financial audit or proof of employee productivity.

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

`report_open` and `data_loaded` are not active-interaction events. Auto-switching
tabs and synthetic DOM changes are excluded. Preview/archive mode is tagged
separately. No continuous mouse/keyboard tracking, active-time estimation or input
contents are recorded.

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

Supported action strings are listed above. Do not emit completion on validation
errors, cancellation, failed promises or timers. Interactive callbacks require a
recent trusted user interaction. The supplied HTML controls its own callbacks,
so this journal is not a cryptographic attestation of business results. Detailed
invoice auditing is intentionally not implemented before reviewing the actual
profitability HTML and its successful processing boundary.

## Monthly retention and deployment

The POST-only `/api/cron/dashboard-usage` endpoint requires its own
`DASHBOARD_USAGE_CRON_SECRET` (32–512 characters), accepts no body and calculates
the cutoff itself. It cannot select another table, employee, report or date.
One transaction deletes at most 10 batches of 1,000 expired usage events using
the `(created_at,id)` index. A non-blocking advisory lock excludes concurrent jobs;
SQL lock/statement timeouts bound contention. No HTML versions, snapshots,
employees, security audit or other application data are deleted. If a backlog
exceeds 10,000 entries, subsequent runs continue clearing it.

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

## Pending invoice audit

The requested record is: employee, invoice number, item names and quantities,
deal amount and currency, action time. User identity and receipt time must remain
server-derived. The eventual adapter should emit only this reviewed schema after
successful invoice processing/calculation, with the existing source/nonce/report
version checks; not when a file is merely selected. Do not capture raw files,
arbitrary form values, passwords, supplier bank details or extra customer data.
The exact field paths, units, amount basis and successful callback must be mapped
from the real report before coding. No generic invoice extraction is enabled.

## Verification

`node --import tsx --test tests/dashboard-usage.test.ts tests/dashboard-usage-cron.test.ts tests/dashboard-usage-install.test.ts`

`node --import tsx tests/dashboard-usage.browser.integration.ts`

`KTS_TEST_PG_BIN=/path/to/postgresql/bin bash scripts/test-dashboard-usage-postgres.sh`

The PostgreSQL fixture creates and removes a dedicated temporary cluster with
synthetic users/reports only. It checks actor-scoped idempotency, revoked view and
preview permissions, server timestamps, keyset pagination, rate limiting and
independence from employee/report deletion and bounded calendar-month physical
retention. It never uses the ambient database URL.

The browser fixture uses isolated synthetic content and blocks external requests;
it exercises Chromium/WebKit opaque-frame handshakes and checks that field values
never cross into the event payload.
