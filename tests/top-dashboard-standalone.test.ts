import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOP_DASHBOARD_STANDALONE_MARKER as marker,
  addStandaloneTopDashboardMarker as add,
  hasStandaloneTopDashboardMarker as has,
  isStandaloneTopDashboardHtml as local,
} from '../src/shared/lib/topDashboardStandalone';
import { detectTopDashboardDataContract as contract } from '../src/shared/lib/topDashboardContentSecurity';

test('standalone metadata is detected as a real bounded tag, not inside JS, comments, text or templates', () => {
  assert.equal(has(marker), true);
  assert.equal(has("<meta content='standalone-v1' name='KTS-DASHBOARD-MODE'>"), true);
  for (const html of [
    `<script>const example='${marker}'</script>`, `<!-- ${marker} -->`,
    `<textarea>${marker}</textarea>`, `<template>${marker}</template>`,
    '<meta name="kts-dashboard-mode" content="shared-v1">', ' '.repeat(65536) + marker,
  ]) assert.equal(has(html), false, html.slice(0,100));
});

test('adding mode metadata preserves author code and is idempotent across ordinary HTML documents', () => {
  for (const html of [
    '<!doctype html><html><head><title>Author</title></head><body><script>window.version=222;</script></body></html>',
    '<!doctype html><html><body>Report without explicit head</body></html>',
    '<!doctype html><body>Report without explicit html</body>',
    '<!-- <head>example</head> --><html><head data-version="999"></head></html>',
    '<!doctype html><html><body><script>const template="<head>example</head>";</script></body></html>',
  ]) {
    const output = add(html);
    assert.equal(has(output), true);
    assert.equal(add(output), output);
    assert.equal(output.replace(`<head>${marker}</head>`, '').replace(marker, ''), html);
    assert.equal(local(output), true);
    assert.equal(contract(output).profile, 'standalone');
    assert.equal(contract(output).snapshotFormat, null);
  }
});

test('unreviewed invoice revisions and static HTML are standalone, existing connected file inputs stay connected', () => {
  const invoice = '<!doctype html><title>Рентабельность счетов</title><input id="fInv" type="file"><script>const format="kts-rent-snapshot"; const authorVersion=999;</script>';
  assert.equal(local(invoice), true);
  assert.equal(contract(invoice).profile, 'standalone');
  assert.equal(contract('<!doctype html><html><body>Static document</body></html>').profile, 'standalone');
  const connected = '<!doctype html><input type="file">';
  assert.equal(local(connected), false);
  assert.equal(contract(connected).profile, 'generic');
  assert.equal(contract(add(connected)).profile, 'standalone');
});
