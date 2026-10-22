import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createTopDashboardFrameBridgeScript,
  getTopDashboardDataAdapterScript,
} from '../src/shared/lib/topDashboardContentSecurity';
import { sandboxPrintScript } from '../src/shared/lib/topDashboardContentSecurity/sandbox/print';
import { framePrintScript } from '../src/shared/lib/topDashboardContentSecurity/frame/print';

// Captured from the monolithic implementation before its responsibility split.
// Exact bytes matter: the browser CSP hashes the generated scripts, and source
// fragments must neither reorder side effects nor introduce escaping changes.
// The later, separately tested print bridge is additive: exclude only that
// exact fragment so the pre-existing snapshots/data/download logic stays pinned.
const adapterCases: Array<{
  name: string;
  args: Parameters<typeof getTopDashboardDataAdapterScript>;
  sha256: string;
}> = [
  { name: 'default', args: [], sha256: 'ddff82ce75968d5fda43fc2cc1c84c7f4dc7f0c688fbe50806420dea9ebf020e' },
  { name: 'purchases', args: ['purchases-v1', 'purchases', false], sha256: '1d2fecf87bdf5759a29bf3a86296d3f3858c497b73a33c328641120c7f5ae775' },
  { name: 'sales analytics', args: ['kts-bundle-v1', 'sales-analytics', false], sha256: 'b01735aa3aef6188feb82e17c552f990a4adee998c83c91b668e8eb1fd39f64d' },
  { name: 'readonly assortment', args: ['kts-bundle-v1', 'assortment-optimization', true], sha256: 'c806e06bcfc62621fce073a2bea9d0edea8974ce18905a063749d13908bb2021' },
  { name: 'generic files', args: ['multi-file-v1', 'generic', false], sha256: '697466194c29fedca27da61ea81e27adf67979cdd78b0df8b493aa5d64d29447' },
  { name: 'readonly generic files', args: ['multi-file-v1', 'generic', true], sha256: '4064e16527021f4d45ca2bd9e03c5764f9ba3cb839fa3974fdb89638de5084de' },
  { name: 'legacy synchronous hydration', args: ['multi-file-v1', 'generic', false, 'loadState'], sha256: '39b06b333ce0df1cc7c59970bdc714b9d1dcc8cb99cc0b548962b069fc594b7d' },
  { name: 'private invoice mode', args: [null, 'profitability', true, null, true], sha256: '889a7ed6f8da22ce2cdc1d6089e2d4d407fda9d5ccad42568b200a207ba8d994' },
  { name: 'unsupported profitability', args: [null, 'profitability-unsupported', true], sha256: '54c7f055ef4bc5cc390a4202ea04d4f5c009d1b868fe1d7951d73fc47e0780e7' },
];

const frameCases: Array<{
  name: string;
  args: Parameters<typeof createTopDashboardFrameBridgeScript>;
  sha256: string;
}> = [
  { name: 'viewer', args: [7, 13, false], sha256: '87237c472bf83a6b6531b5d27dfda71d9b83420b3d99b3a16325d96b5cd67487' },
  { name: 'manager', args: [7, 13, true], sha256: '53990341f2e62da5399bafbdd52fcf459e520389ad7bd3583d0ee256703c74a2' },
  { name: 'audited invoices', args: [83, 19, true, { preview: false }], sha256: '568f47ceb4cb081fee1abf282065ba21be3d837c391b133e81d9719a130f8f03' },
  { name: 'invoice preview', args: [83, 19, false, { preview: true }], sha256: '28c432f3fc98140374948feb23f064090cee93bd9fd973cb2c48eb70cd8945bd' },
  { name: 'invoices without audit', args: [83, 19, true, { preview: false, auditEnabled: false }], sha256: 'f0d985cdad62e71cdabeb190dd2bac4bf0ea0c236e8547c67671bbd327084192' },
];

function sha256(source: string) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

for (const fixture of adapterCases) {
  test(`sandbox adapter preserves pre-refactor bytes: ${fixture.name}`, () => {
    const script = getTopDashboardDataAdapterScript(...fixture.args);
    assert.equal(script.split(sandboxPrintScript()).length, 2);
    assert.equal(sha256(script.replace(sandboxPrintScript(), '')), fixture.sha256);
  });
}

for (const fixture of frameCases) {
  test(`trusted frame preserves pre-refactor bytes: ${fixture.name}`, () => {
    const script = createTopDashboardFrameBridgeScript(...fixture.args);
    assert.equal(script.split(framePrintScript()).length, 2);
    assert.equal(sha256(script.replace(framePrintScript(), '')), fixture.sha256);
  });
}
