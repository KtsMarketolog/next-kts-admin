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
// Label discovery was advanced after static/runtime parity, minified-bundle and
// browser upload/restore checks; input identities and payload handling are unchanged.
const compiledReadonlySelectors = ',button[data-kts-handler-onclick*="pickFiles("],button[data-kts-handler-onclick*="connectFolder("],button[data-kts-handler-onclick*="refreshFromFolder("]';
const adapterCases: Array<{
  name: string;
  args: Parameters<typeof getTopDashboardDataAdapterScript>;
  sha256: string;
}> = [
  { name: 'default', args: [], sha256: 'eda05cca1384580b3f64f10bc0c6f0b1dcf90566f5bfea1ad7403789334b3069' },
  { name: 'purchases', args: ['purchases-v1', 'purchases', false], sha256: 'a7f165436ebcb6c21291acf28f397f48ff7dff3385568730228779f7f7e96410' },
  { name: 'sales analytics', args: ['kts-bundle-v1', 'sales-analytics', false], sha256: 'eb3ad4707f5ea3979274e303d05540b4415a46c96857d577767a29d5646264de' },
  { name: 'readonly assortment', args: ['kts-bundle-v1', 'assortment-optimization', true], sha256: 'fc2babf68df21e0472e868798543d010335b71b0af45d65239bd374809cede48' },
  { name: 'generic files', args: ['multi-file-v1', 'generic', false], sha256: 'e86c7bd802cae27add0964bbd0bf72f2a8407d8d4c268919b516f3a7dbc4c17b' },
  { name: 'readonly generic files', args: ['multi-file-v1', 'generic', true], sha256: 'd81e19b620c1d89e12194ab69fe509b1d42b316a4ad796f0da61088ccbcb523c' },
  { name: 'legacy synchronous hydration', args: ['multi-file-v1', 'generic', false, 'loadState'], sha256: '0df6eb8ce090c714cd246f90a50ec3cbc512cdca2cba4dd27d305f0e669e4b90' },
  { name: 'private invoice mode', args: [null, 'profitability', true, null, true], sha256: 'eedd506d22abbe11be9431690446b13891ddf5a36ab5910de9517d075880593e' },
  { name: 'unsupported profitability', args: [null, 'profitability-unsupported', true], sha256: '5fcdcadb5463b16636c581eadbc8a523c46689afa6cacb8a2264112b210a6619' },
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
