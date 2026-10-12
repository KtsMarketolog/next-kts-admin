# Temporary email confirmation exemption

The owner explicitly authorized an exception of up to three months during the
email delivery incident on 12 October 2026, then explicitly expanded it to both
employees and clients while Yandex mail is unavailable. The approved end must
be no later than 12 January 2027. This weakens sign-in security: possession of a
valid password is sufficient during the approved interval.

The code alone does not activate the exception. Production activation is a
separate configuration change, with safety review of the concrete start and end
timestamps within the owner's authorized period. Keep
`ADMIN_2FA_ENABLED=true`; do not replace the bounded exception with a permanent
global disable flag.

Both login routes read two server environment settings:

| Setting | Meaning |
| --- | --- |
| `EMAIL_2FA_OUTAGE_START_AT` | Inclusive start, in strict UTC format `YYYY-MM-DDTHH:mm:ss.sssZ` |
| `EMAIL_2FA_OUTAGE_END_AT` | Exclusive end, in the same UTC format |

Both values must be valid timestamps. End must be later than start and no later
than three UTC calendar months after start, retaining the time of day and
clamping to the last day when the target month is shorter. Missing values,
invalid dates, a future start, an expired interval, or an oversized interval do
not exempt login from email confirmation. Settings must remain
server-only; never expose them through `NEXT_PUBLIC_*` or request parameters.

The interval is checked on every employee and client password login. Email confirmation
automatically resumes at the exclusive end timestamp, without a scheduler or
another deployment. Existing sessions are not revoked; their normal lifetime
remains unchanged. Password validation, account activation checks, and rate
limits continue to apply. After expiry, the employee route again follows
`ADMIN_2FA_ENABLED`, and the client route again follows each client's existing
`requireTwoFactor` setting. Those original settings are not modified.

Before activation, verify the exact approved interval, current server UTC time,
`ADMIN_2FA_ENABLED=true`, and the deployed policy tests. Only then apply the two
approved settings through the normal production configuration/reload procedure.
For early termination, remove both exception settings and reload the application;
keep `ADMIN_2FA_ENABLED=true`. Do not extend the period without new owner approval.
