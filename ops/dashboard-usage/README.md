# Dashboard usage journal

`/admin/dashboard-usage` is restricted to the main `admin` role. Viewing a report
does not grant access to this journal. Extending the journal audience or deleting
history requires a separate agreed policy. There is no automatic retention job.

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
invoice auditing is intentionally not implemented until its schema is agreed.

## Verification

`node --import tsx --test tests/dashboard-usage.test.ts`

`node --import tsx tests/dashboard-usage.browser.integration.ts`

`KTS_TEST_PG_BIN=/path/to/postgresql/bin bash scripts/test-dashboard-usage-postgres.sh`

The PostgreSQL fixture creates and removes a dedicated temporary cluster with
synthetic users/reports only. It checks actor-scoped idempotency, revoked view and
preview permissions, server timestamps, keyset pagination, rate limiting and
retention after employee/report deletion. It never uses the ambient database URL.

The browser fixture uses isolated synthetic content and blocks external requests;
it exercises Chromium/WebKit opaque-frame handshakes and checks that field values
never cross into the event payload.
