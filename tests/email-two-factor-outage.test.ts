import assert from 'node:assert/strict';
import test from 'node:test';

import { isEmailTwoFactorOutageActive } from '../src/shared/lib/emailTwoFactorOutage';

const start = '2026-10-12T13:45:10.000Z';
const end = '2027-01-12T13:45:10.000Z';
const config = { EMAIL_2FA_OUTAGE_START_AT: start, EMAIL_2FA_OUTAGE_END_AT: end };

test('email exemption is absent by default and starts inclusively, ends exclusively', () => {
  assert.equal(isEmailTwoFactorOutageActive(new Date(start), {}), false);
  assert.equal(isEmailTwoFactorOutageActive(new Date(Date.parse(start) - 1), config), false);
  assert.equal(isEmailTwoFactorOutageActive(new Date(start), config), true);
  assert.equal(isEmailTwoFactorOutageActive(new Date(Date.parse(end) - 1), config), true);
  assert.equal(isEmailTwoFactorOutageActive(new Date(end), config), false);
  assert.equal(isEmailTwoFactorOutageActive(new Date(Date.parse(end) + 1), config), false);
});

test('missing, malformed, normalized, local-time and invalid clock values fail closed', () => {
  for (const invalid of [undefined, '', 'true', '2026-10-12', '2026-10-12T13:45:10Z',
    '2026-10-12T13:45:10.000', '2026-10-12T16:45:10.000+03:00', '2026-02-30T13:45:10.000Z',
    '2026-10-12T24:00:00.000Z', ` ${start}`, `${start} `]) {
    assert.equal(isEmailTwoFactorOutageActive(new Date(start), { ...config, EMAIL_2FA_OUTAGE_START_AT: invalid }), false);
    assert.equal(isEmailTwoFactorOutageActive(new Date(start), { ...config, EMAIL_2FA_OUTAGE_END_AT: invalid }), false);
  }
  assert.equal(isEmailTwoFactorOutageActive(new Date(NaN), config), false);
});

test('reversed, zero length and more than three calendar months cannot disable OTP', () => {
  for (const invalidEnd of [start, '2026-10-11T13:45:10.000Z', '2027-01-12T13:45:10.001Z', '2027-10-12T13:45:10.000Z']) {
    assert.equal(isEmailTwoFactorOutageActive(new Date(start), { ...config, EMAIL_2FA_OUTAGE_END_AT: invalidEnd }), false);
  }
  assert.equal(isEmailTwoFactorOutageActive(new Date(start), { ...config, EMAIL_2FA_OUTAGE_END_AT: '2026-10-12T13:45:10.001Z' }), true);
});

test('three calendar month bound clamps month ends and respects leap years, not a fixed day count', () => {
  for (const [from, until] of [
    ['2026-01-31T13:45:10.123Z', '2026-04-30T13:45:10.123Z'],
    ['2026-11-30T13:45:10.123Z', '2027-02-28T13:45:10.123Z'],
    ['2027-11-30T13:45:10.123Z', '2028-02-29T13:45:10.123Z'],
    ['2028-02-29T13:45:10.123Z', '2028-05-29T13:45:10.123Z'],
    ['2026-07-01T13:45:10.123Z', '2026-10-01T13:45:10.123Z'],
  ]) {
    const range = { EMAIL_2FA_OUTAGE_START_AT: from, EMAIL_2FA_OUTAGE_END_AT: until };
    assert.equal(isEmailTwoFactorOutageActive(new Date(from), range), true, from);
    assert.equal(isEmailTwoFactorOutageActive(new Date(from), {
      ...range, EMAIL_2FA_OUTAGE_END_AT: new Date(Date.parse(until) + 1).toISOString(),
    }), false, from);
  }
});
