import { createHash } from 'node:crypto';

export type SalesRestoreBodyRange = { bodyStart: number; bodyEnd: number };
export type SalesRestoreReadyRanges = {
  acceptBundle: SalesRestoreBodyRange;
  render: SalesRestoreBodyRange;
  k3Capture: SalesRestoreBodyRange;
  handleFiles?: SalesRestoreBodyRange;
};

// Reviewed author scripts only. Offsets cover braces, with an exclusive end;
// neither customer snapshot data nor inferred function shapes authorize hooks.
const REVIEWED_SALES_SCRIPTS: readonly (SalesRestoreReadyRanges & { sha256: string })[] = [
  {
    sha256: 'fddd19d5b2e5a07e74aae75e604a290e5d48de5742bb379fbb6a27e1ee93f751',
    acceptBundle: { bodyStart: 10969, bodyEnd: 11809 },
    handleFiles: { bodyStart: 16966, bodyEnd: 44455 },
    render: { bodyStart: 89844, bodyEnd: 93279 },
    k3Capture: { bodyStart: 129875, bodyEnd: 130024 },
  },
  {
    sha256: '6c31b5bb0697ba1ddb182dec89c01943bc77d30a2481f2bfe70bcfad2b2f205d',
    acceptBundle: { bodyStart: 10532, bodyEnd: 11372 },
    handleFiles: { bodyStart: 16419, bodyEnd: 43908 },
    render: { bodyStart: 89154, bodyEnd: 92589 },
    k3Capture: { bodyStart: 129185, bodyEnd: 129334 },
  },
];

const CAUGHT_FAILURE = '\nif (__ktsSalesRestoreState) __ktsSalesRestoreState.failed = true;';
const RESTORE_SETUP = `
;var __ktsSalesRestoreId = 0;
var __ktsSalesRestoreState = null;
function __ktsSalesFailRestore() {
  var id = __ktsSalesRestoreId;
  if (!Number.isSafeInteger(id) || id <= 0) return;
  __ktsSalesRestoreId = 0;
  if (__ktsSalesRestoreState) __ktsSalesRestoreState.failed = true;
  try {
    window.dispatchEvent(new CustomEvent('kts-top-dashboard-data-error', { detail: { restoreId: id } }));
  } catch { /* Preserve the native loader's error handling. */ }
}
window.addEventListener('kts-top-dashboard-restore-start', function(event) {
  var id = event.detail && event.detail.restoreId;
  if (Number.isSafeInteger(id) && id > 0) __ktsSalesRestoreId = id;
});
window.addEventListener('kts-top-dashboard-data-error', function(event) {
  if (event.detail && event.detail.restoreId === __ktsSalesRestoreId) __ktsSalesRestoreId = 0;
});
`;

/** Transform explicitly reviewed synchronous bodies. The HTML entry point below
 * is the production authorization boundary; this helper also lets synthetic
 * tests exercise the identical transformation without accepting their HTML. */
export function instrumentSalesRestoreReadySource(
  source: string,
  ranges: SalesRestoreReadyRanges,
): string | null {
  if (source.includes('__ktsSalesRestoreState')) return null;
  const ordered = [ranges.acceptBundle, ranges.render, ranges.k3Capture, ...(ranges.handleFiles ? [ranges.handleFiles] : [])]
    .sort((left, right) => left.bodyStart - right.bodyStart);
  if (ordered.some((range, index) => !Number.isSafeInteger(range.bodyStart)
    || !Number.isSafeInteger(range.bodyEnd)
    || range.bodyStart < 0 || range.bodyEnd > source.length
    || range.bodyStart >= range.bodyEnd
    || source[range.bodyStart] !== '{' || source[range.bodyEnd - 1] !== '}'
    || (index > 0 && ordered[index - 1].bodyEnd > range.bodyStart))) return null;

  const patches: Array<SalesRestoreBodyRange & { replacement: string }> = [];
  for (const [range, marker] of [
    [ranges.render, '} catch (err){'],
    [ranges.k3Capture, 'catch (e){'],
  ] as const) {
    const body = source.slice(range.bodyStart, range.bodyEnd);
    if (body.split(marker).length !== 2) return null;
    patches.push({ ...range, replacement: body.replace(marker, marker + CAUGHT_FAILURE) });
  }
  if (ranges.handleFiles) {
    let body = source.slice(ranges.handleFiles.bodyStart, ranges.handleFiles.bodyEnd);
    // These are the reviewed snapshot-decode, invalid-bundle and file-read
    // failures. Other catches intentionally tolerate absent optional sources.
    for (const marker of [
      'try { u = unpackBundle(await readBundle(buf)); }\n        catch (e){',
      'if (!u){',
      '} catch (err){',
    ]) {
      if (body.split(marker).length !== 2) return null;
      body = body.replace(marker, marker + '\n__ktsSalesFailRestore();');
    }
    patches.push({ ...ranges.handleFiles, replacement: body });
  }

  const body = source.slice(ranges.acceptBundle.bodyStart + 1, ranges.acceptBundle.bodyEnd - 1);
  patches.push({ ...ranges.acceptBundle, replacement: `{
  const __ktsSalesPreviousState = __ktsSalesRestoreState;
  const __ktsSalesCurrentState = { restoreId: __ktsSalesRestoreId, failed: false, completed: false };
  __ktsSalesRestoreState = __ktsSalesCurrentState;
  try {
    const __ktsSalesResult = (function() {${body}\n}).apply(this, arguments);
    __ktsSalesCurrentState.completed = true;
    return __ktsSalesResult;
  } finally {
    __ktsSalesRestoreState = __ktsSalesPreviousState;
    const __ktsSalesId = __ktsSalesCurrentState.restoreId;
    if (Number.isSafeInteger(__ktsSalesId) && __ktsSalesId > 0 && __ktsSalesId === __ktsSalesRestoreId) {
      __ktsSalesRestoreId = 0;
      try {
        window.dispatchEvent(new CustomEvent(
          __ktsSalesCurrentState.completed && !__ktsSalesCurrentState.failed
            ? 'kts-top-dashboard-data-ready' : 'kts-top-dashboard-data-error',
          { detail: { restoreId: __ktsSalesId } }
        ));
      } catch { /* Reporting must preserve the author's return or thrown error. */ }
    }
  }
}` });

  let patched = source;
  for (const patch of patches.sort((left, right) => right.bodyStart - left.bodyStart)) {
    patched = patched.slice(0, patch.bodyStart) + patch.replacement + patched.slice(patch.bodyEnd);
  }
  // Appending keeps the author's directive prologue intact. var declarations
  // are hoisted for startup renders; restore messages arrive after setup.
  return patched + RESTORE_SETUP;
}

export function instrumentReviewedSalesRestoreReady(html: string): string {
  return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
    (tag: string, attributes: string, source: string) => {
      if (attributes.trim()) return tag;
      const hash = createHash('sha256').update(source, 'utf8').digest('hex');
      const reviewed = REVIEWED_SALES_SCRIPTS.find((profile) => profile.sha256 === hash);
      if (!reviewed) return tag;
      const patched = instrumentSalesRestoreReadySource(source, reviewed);
      return patched === null ? tag : `<script>${patched}</script>`;
    });
}
