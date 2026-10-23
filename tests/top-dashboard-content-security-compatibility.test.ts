import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createTopDashboardFrameBridgeScript,
  getTopDashboardDataAdapterScript,
} from '../src/shared/lib/topDashboardContentSecurity';
import { sandboxPrintScript } from '../src/shared/lib/topDashboardContentSecurity/sandbox/print';
import { framePrintScript } from '../src/shared/lib/topDashboardContentSecurity/frame/print';

// Adapters were captured before the monolithic implementation's responsibility split.
// Exact bytes matter: the browser CSP hashes the generated scripts, and source
// fragments must neither reorder side effects nor introduce escaping changes.
// The later, separately tested print bridge is additive: exclude only that
// exact fragment so the pre-existing snapshots/data/download logic stays pinned.
// Trusted-frame hashes were reviewed and advanced for the intentional post-save
// warning relay. All other frame fragments and sandbox-adapter bytes are unchanged.
const compiledReadonlySelectors = ',button[data-kts-handler-onclick*="pickFiles("],button[data-kts-handler-onclick*="connectFolder("],button[data-kts-handler-onclick*="refreshFromFolder("]';
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
  { name: 'viewer', args: [7, 13, false], sha256: '28df8cbe1bf800a8086e51dce9330a300a2d377cbed1aafb5d2cc4e1f88cb522' },
  { name: 'manager', args: [7, 13, true], sha256: 'dbe4baef862ef330a5f096d2afe13a8c51f4b8f7a2abe509f54371c49c6a53d9' },
  { name: 'audited invoices', args: [83, 19, true, { preview: false }], sha256: '096b92f1349fc2ac26a4cc12c318a2829f4d6038b55963bf57fc8976c5cdb0bc' },
  { name: 'invoice preview', args: [83, 19, false, { preview: true }], sha256: '76a621acfcab17d7ddbc8c2f916285df806facba3d0e7ec71c7cb4d4dc71d11f' },
  { name: 'invoices without audit', args: [83, 19, true, { preview: false, auditEnabled: false }], sha256: '815759ff945012c7728b788e0d987a0c08a756919eb83cf9df4c2cc6f92e6158' },
];

function sha256(source: string) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

for (const fixture of adapterCases) {
  test(`sandbox adapter preserves pre-refactor bytes: ${fixture.name}`, () => {
    const script = getTopDashboardDataAdapterScript(...fixture.args);
    assert.equal(script.split(sandboxPrintScript()).length, 2);
    // The only new readonly change is a selector alias for compiled callbacks.
    assert.equal(script.split(compiledReadonlySelectors).length, 2);
    assert.equal(sha256(script.replace(sandboxPrintScript(), '').replace(compiledReadonlySelectors, '')), fixture.sha256);
  });
}

for (const fixture of frameCases) {
  test(`trusted frame preserves reviewed bytes including saved-upload warnings: ${fixture.name}`, () => {
    const script = createTopDashboardFrameBridgeScript(...fixture.args);
    assert.equal(script.split(framePrintScript()).length, 2);
    assert.equal(sha256(script.replace(framePrintScript(), '')), fixture.sha256);
  });
}
