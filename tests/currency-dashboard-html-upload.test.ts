import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getBuiltinCurrencyDashboardHtmlSeed, inspectCurrencyDashboardUpload, prepareCurrencyDashboardHtml } from '../src/shared/lib/currencyDashboardHtmlUpload';
import { buildCurrencyDashboardContentSecurityPolicy, renderCurrencyDashboardHtml } from '../src/shared/lib/currencyDashboardHtml';

const nonce = 'c87b0ef3-39af-4dbf-b646-cf7f41347c47';

test('seed retains immutable original V25 and reviewed V21 rollback, without mutable metadata leakage', () => {
  const seed = getBuiltinCurrencyDashboardHtmlSeed();
  assert.equal(seed.current.htmlContent, readFileSync('assets/currency-dashboard/kursy_valyut_v25.html', 'utf8'));
  assert.equal(seed.previous.htmlContent, readFileSync('assets/currency-dashboard/kursy_valyut_v21.html', 'utf8'));
  assert.equal(seed.current.sourceVersion, 'V25');
  assert.equal(seed.previous.sourceVersion, 'V21');
  seed.current.sourceVersion = 'tampered';
  assert.equal(getBuiltinCurrencyDashboardHtmlSeed().current.sourceVersion, 'V25');
});

test('default rendering adapts V25 and remains nonce-bound, opaque and private by default', () => {
  const html = renderCurrencyDashboardHtml(nonce, 'https://example.test');
  assert.match(html, /"canManage":false/);
  assert.match(html, /id="pgBase"/);
  assert.match(html, /id="f27Form"/);
  assert.doesNotMatch(html, /__KTS_CURRENCY_BOOTSTRAP__/);
  const policy = buildCurrencyDashboardContentSecurityPolicy(html);
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /form-action 'none'/);
  assert.doesNotMatch(policy, /allow-same-origin|unsafe-eval/);
});

test('draft preview omits employee usage adapter and cannot gain shared write permissions', () => {
  const raw = getBuiltinCurrencyDashboardHtmlSeed().current.htmlContent;
  const preview = renderCurrencyDashboardHtml(nonce, 'https://example.test', false, raw, { trackUsage: false });
  const published = renderCurrencyDashboardHtml(nonce, 'https://example.test', true, raw);
  assert.match(preview, /"canManage":false/);
  assert.match(published, /"canManage":true/);
  assert.ok(published.length > preview.length);
  assert.doesNotMatch(preview, /kts-dashboard-usage-v1/);
});

test('known source labels are not a version allowlist; compatible later author HTML is adapted', () => {
  const future = getBuiltinCurrencyDashboardHtmlSeed().current.htmlContent.replace(/\bV25\b/g, 'V26');
  assert.deepEqual(inspectCurrencyDashboardUpload(future), { sourceVersion: 'V26' });
  assert.equal(prepareCurrencyDashboardHtml(future), prepareCurrencyDashboardHtml(future));
});

test('legacy bypass requires the exact reviewed contents, never a forged bootstrap marker or version', () => {
  const old = getBuiltinCurrencyDashboardHtmlSeed().previous.htmlContent;
  assert.deepEqual(inspectCurrencyDashboardUpload(old), { sourceVersion: 'V21' });
  assert.equal(prepareCurrencyDashboardHtml(old), old);
  assert.throws(() => inspectCurrencyDashboardUpload(old + '\n<script>window.evil=true</script>'), /обёртка|несовместим/);
});

test('empty, invalid, unsupported and oversized uploads cannot be accepted on title alone', () => {
  for (const raw of ['', '\0<html></html>', ' '.repeat(2 * 1024 * 1024 + 1), '<html><title>Курсы валют V25</title></html>']) {
    assert.throws(() => inspectCurrencyDashboardUpload(raw));
  }
  const changed = getBuiltinCurrencyDashboardHtmlSeed().current.htmlContent.replace('function loadToday(', 'function renamedLoadToday(');
  assert.throws(() => inspectCurrencyDashboardUpload(changed), /loadToday/);
});
