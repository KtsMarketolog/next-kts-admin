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
// Document-readiness hashes include the streamed-HTML gate, verified with late
// native/DCL handlers in Chromium and WebKit and the receiver unit regressions.
const compiledReadonlySelectors = ',button[data-kts-handler-onclick*="pickFiles("],button[data-kts-handler-onclick*="connectFolder("],button[data-kts-handler-onclick*="refreshFromFolder("]';
const adapterCases: Array<{
  name: string;
  args: Parameters<typeof getTopDashboardDataAdapterScript>;
  sha256: string;
}> = [
  { name: 'default', args: [], sha256: 'f32b0ed8e33e4acdf625be27b3604abd40eb447a11a7cec51f25020d1b963902' },
  { name: 'purchases', args: ['purchases-v1', 'purchases', false], sha256: '8bb671cc1daae0d4ae626c3a1bd48e84d8c4c675c38bbe3dcabe1127ce995618' },
  { name: 'sales analytics', args: ['kts-bundle-v1', 'sales-analytics', false], sha256: '3341894ec616f10fdf5362a7dcb188d56df135a9f5005e0555be63c972eb5bc8' },
  { name: 'readonly assortment', args: ['kts-bundle-v1', 'assortment-optimization', true], sha256: 'eded676939ef6e5d738073d9f5f22dc2eea9ab4c693b8d17dc7c1b783a4d43b1' },
  { name: 'generic files', args: ['multi-file-v1', 'generic', false], sha256: 'ee4f9c5b8f14a30fadb5101dc57c01767c08a2bb0ca7f4d8c6b29c46fca7fa7a' },
  { name: 'readonly generic files', args: ['multi-file-v1', 'generic', true], sha256: '055b2c16bdf8f243812e40b64bfbb1e1e2ebfdff41dc79734b3636f286a8fd0d' },
  { name: 'legacy synchronous hydration', args: ['multi-file-v1', 'generic', false, 'loadState'], sha256: 'b65970524a52a30d9650160494c281ea487267de146112548edccd2f84f3ab19' },
  { name: 'private invoice mode', args: [null, 'profitability', true, null, true], sha256: 'e2f16924aff671628ae4e5316fec644c1f8e92963cccb9197a68dfdd220dedff' },
  { name: 'unsupported profitability', args: [null, 'profitability-unsupported', true], sha256: '7ca799e8e123159f592ff1f1965eddd645b8e9d3d49d6a4c5bcc19958d1bad62' },
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
