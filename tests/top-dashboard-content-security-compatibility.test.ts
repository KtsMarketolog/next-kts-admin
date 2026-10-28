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
// warning relay. Sandbox hashes now include reviewed legacy restore start/error
// lifecycle and serialization, covered by office and native loader regressions.
const compiledReadonlySelectors = ',button[data-kts-handler-onclick*="pickFiles("],button[data-kts-handler-onclick*="connectFolder("],button[data-kts-handler-onclick*="refreshFromFolder("]';
const adapterCases: Array<{
  name: string;
  args: Parameters<typeof getTopDashboardDataAdapterScript>;
  sha256: string;
}> = [
  { name: 'default', args: [], sha256: 'ed58f6a9f8d87fd311bb9503f6596b4ba9871615ddcefbfa53bb960d0371a9a6' },
  { name: 'purchases', args: ['purchases-v1', 'purchases', false], sha256: '46bf65bbcad86ff0c911056de0b53509b4ef8d94834a6ea8343fc0f6238a084b' },
  { name: 'sales analytics', args: ['kts-bundle-v1', 'sales-analytics', false], sha256: 'bca75f403ad76b29f5193f26542ca381e8aebd541b2c0d112722008bbdf3a7ac' },
  { name: 'readonly assortment', args: ['kts-bundle-v1', 'assortment-optimization', true], sha256: '164d3708c5edaee3bbbab14df15407157f18997b5b958c37e6d27e4aae61542c' },
  { name: 'generic files', args: ['multi-file-v1', 'generic', false], sha256: '00b4a7aaedf57ff8c9d5c093991019e5393d84f466589c2b29703ba3266d8dac' },
  { name: 'readonly generic files', args: ['multi-file-v1', 'generic', true], sha256: '2c4d6e93718b1829a3694815b382dca2453d57b64ae8b7823710be9a22ffda77' },
  { name: 'legacy synchronous hydration', args: ['multi-file-v1', 'generic', false, 'loadState'], sha256: '9cba62de0f14ba72cb88a1fd30837796a679abf0b4541df722a3466e48842d0e' },
  { name: 'private invoice mode', args: [null, 'profitability', true, null, true], sha256: '8f9b554dea795d4f4383a02f471b5721433c7acc40ad21b2dbedcd7f9cedd148' },
  { name: 'unsupported profitability', args: [null, 'profitability-unsupported', true], sha256: 'f18bbf17766e723849977d70efc9b3c49d92779e6bfbcbe692a6281075a37bf4' },
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
  test(`sandbox adapter preserves reviewed bytes including restore lifecycle: ${fixture.name}`, () => {
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
