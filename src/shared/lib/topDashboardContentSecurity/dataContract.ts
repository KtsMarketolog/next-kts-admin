import sanitizeHtml from 'sanitize-html';
import { isProfitabilityHtmlCandidate, isSupportedProfitabilityHtml } from '../dashboardProfitabilityHtml';
import { hasStandaloneTopDashboardMarker } from '../topDashboardStandalone';
import type { TopDashboardProfile, TopDashboardSnapshotFormat } from '../db/topDashboardDomain';
import { TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES, type TopDashboardMultiFileSnapshotTarget } from '../topDashboardMultiFileSnapshot';

export type TopDashboardDataContract = {
  mode: 'legacy' | 'generic' | 'disabled';
  snapshotFormat: TopDashboardSnapshotFormat | null;
  profile: TopDashboardProfile | null;
  directUploadTarget: TopDashboardMultiFileSnapshotTarget | null;
};


export function detectTopDashboardExpectedProfile(
  htmlContent: string,
): TopDashboardProfile | null {
  const hasPurchasesInput =
    /\bid\s*=\s*(?:"snapInp"|'snapInp')/i.test(htmlContent)
    || /\bgetElementById\(\s*(?:"snapInp"|'snapInp')\s*\)/i.test(htmlContent);
  const hasPurchasesSignature =
    /\bPARSERS\s*\.\s*purchases\b/i.test(htmlContent)
    // Do not let an unfinished <title consume later opening tags and restart
    // the same suffix scan for each one. This is only a profile hint, not an
    // authorization grant; application signatures above remain unchanged.
    || /(?:<title\b[^<>]*>|Дашборд\s*[«"]?)\s*[^<\n]{0,80}Управление\s+закупками/iu.test(htmlContent);
  if (hasPurchasesInput && hasPurchasesSignature) {
    return 'purchases';
  }

  if (
    /\bDASH_NAME\s*=\s*(?:"аналитика_продаж"|'аналитика_продаж')/iu.test(htmlContent)
  ) {
    return 'sales-analytics';
  }

  if (
    /\bDASH_NAME\s*=\s*(?:"оптимизация_ассортимента"|'оптимизация_ассортимента')/iu.test(htmlContent)
  ) {
    return 'assortment-optimization';
  }

  const hasSalesSources = /\bSALES_SOURCES\b/.test(htmlContent);
  const hasAssortmentSources = /\bASSORT_SOURCES\b/.test(htmlContent);
  if (hasSalesSources !== hasAssortmentSources) {
    return hasSalesSources ? 'sales-analytics' : 'assortment-optimization';
  }

  return null;
}

export function detectTopDashboardExpectedSnapshotFormat(
  htmlContent: string,
): TopDashboardSnapshotFormat | null {
  const profile = detectTopDashboardExpectedProfile(htmlContent);
  if (profile === 'purchases') {
    return 'purchases-v1';
  }

  if (
    /\bformat\s*:\s*(?:"kts-bundle"|'kts-bundle')/i.test(htmlContent)
    || /\bformat\s*!==?\s*(?:"kts-bundle"|'kts-bundle')/i.test(htmlContent)
  ) {
    return 'kts-bundle-v1';
  }

  return null;
}

export function detectTopDashboardDataContract(
  htmlContent: string,
): TopDashboardDataContract {
  // Detailed invoice instrumentation is optional. Local files must never be
  // captured as shared data just because the author's application changed.
  if (isSupportedProfitabilityHtml(htmlContent)) {
    return { mode: 'disabled', snapshotFormat: null, profile: 'profitability', directUploadTarget: null };
  }
  if (hasStandaloneTopDashboardMarker(htmlContent) || isProfitabilityHtmlCandidate(htmlContent)) {
    return { mode: 'disabled', snapshotFormat: null, profile: 'standalone', directUploadTarget: null };
  }
  const profile = detectTopDashboardExpectedProfile(htmlContent);
  const snapshotFormat = detectTopDashboardExpectedSnapshotFormat(htmlContent);
  if (profile && snapshotFormat) {
    return { mode: 'legacy', snapshotFormat, profile, directUploadTarget: null };
  }
  const staticFileInputs = collectTopDashboardStaticFileInputs(htmlContent);
  // This broad source scan intentionally also sees literal markup embedded in
  // scripts/templates. It preserves generic capture for dashboards that add
  // their file input at runtime, but is never sufficient to authorize the
  // direct management shortcut below.
  const sourceFileInputs = scanTopDashboardSourceFileInputs(htmlContent);
  const createsInputAtRuntime = /\b(?:document\s*\.\s*)?createElement\s*\(\s*(?:"input"|'input')\s*\)/iu
    .test(htmlContent);
  const assignsRuntimeFileType = /(?:\.\s*type\s*=\s*(?:"file"|'file')|\.\s*setAttribute\s*\(\s*(?:"type"|'type')\s*,\s*(?:"file"|'file')\s*\)|\btype\s*:\s*(?:"file"|'file'))/iu
    .test(htmlContent);
  const createsRuntimeFileInput = createsInputAtRuntime && assignsRuntimeFileType;
  const mutatesFileMultiplicityAtRuntime = /(?:\.\s*(?:multiple|webkitdirectory|directory)\s*=|\.\s*(?:setAttribute|toggleAttribute)\s*\(\s*(?:"(?:multiple|webkitdirectory|directory)"|'(?:multiple|webkitdirectory|directory)'))/iu
    .test(htmlContent);
  const directUploadIsUncertain = createsRuntimeFileInput
    || sourceFileInputs.uncertain
    || sourceFileInputs.count > staticFileInputs.length
    || mutatesFileMultiplicityAtRuntime;
  const hasFileInput = staticFileInputs.length > 0
    || sourceFileInputs.count > 0
    || createsRuntimeFileInput;
  const directUploadTarget = detectTopDashboardDirectUploadTarget(
    staticFileInputs,
    directUploadIsUncertain,
  );
  return hasFileInput
    ? {
        mode: 'generic',
        snapshotFormat: 'multi-file-v1',
        profile: 'generic',
        directUploadTarget,
      }
    : {
        mode: 'disabled',
        snapshotFormat: null,
        profile: 'standalone',
        directUploadTarget: null,
      };
}

const DIRECT_TARGET_UNSAFE_TEXT_PATTERN =
  /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

type TopDashboardStaticFileInput = Record<string, string>;
const TOP_DASHBOARD_SOURCE_INPUT_SCAN_LIMIT = 256;

function collectTopDashboardStaticFileInputs(htmlContent: string) {
  const inputs: TopDashboardStaticFileInput[] = [];
  try {
    sanitizeHtml(htmlContent, {
      allowedTags: [],
      allowedAttributes: {},
      nonTextTags: ['script', 'style', 'textarea', 'option', 'title', 'noscript', 'template'],
      transformTags: {
        input: (tagName, attributes) => {
          if (attributes.type?.toLowerCase() === 'file') inputs.push({ ...attributes });
          return { tagName, attribs: attributes };
        },
      },
    });
  } catch {
    return [];
  }
  return inputs;
}

function scanTopDashboardSourceFileInputs(htmlContent: string) {
  const inputStartPattern = /<input/giu;
  let count = 0;
  let inputTags = 0;
  let cursor = 0;

  while (cursor < htmlContent.length) {
    inputStartPattern.lastIndex = cursor;
    const match = inputStartPattern.exec(htmlContent);
    if (!match) break;
    const start = match.index;
    const boundary = htmlContent[start + 6] ?? '';
    if (boundary && /[A-Za-z0-9:_-]/u.test(boundary)) {
      cursor = start + 6;
      continue;
    }
    inputTags += 1;
    if (inputTags > TOP_DASHBOARD_SOURCE_INPUT_SCAN_LIMIT) {
      return { count, uncertain: true };
    }

    let quote = '';
    let end = -1;
    for (let index = start + 6; index < htmlContent.length; index += 1) {
      const character = htmlContent[index]!;
      const next = htmlContent[index + 1] ?? '';
      if (character === '\\' && (next === '"' || next === "'")) {
        if (!quote) quote = next;
        else if (quote === next) quote = '';
        index += 1;
        continue;
      }
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '>') {
        end = index;
        break;
      }
    }
    if (end < 0) return { count, uncertain: true };

    const candidate = htmlContent
      .slice(start, end + 1)
      .replace(/\\(["'])/gu, '$1');
    if (collectTopDashboardStaticFileInputs(candidate).length > 0) count += 1;
    cursor = end + 1;
  }

  return { count, uncertain: false };
}

function readDirectTargetAttribute(
  attributes: TopDashboardStaticFileInput,
  attribute: 'id' | 'name',
) {
  const rawValue = attributes[attribute] ?? '';
  let value: string;
  try {
    value = rawValue.normalize('NFC');
  } catch {
    return { safe: false, value: null } as const;
  }
  if (!value || value !== value.trim()) return { safe: true, value: null } as const;
  if (
    DIRECT_TARGET_UNSAFE_TEXT_PATTERN.test(value)
    || new TextEncoder().encode(value).byteLength
      > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES
  ) {
    return { safe: false, value: null } as const;
  }
  return { safe: true, value } as const;
}

function detectTopDashboardDirectUploadTarget(
  staticFileInputs: TopDashboardStaticFileInput[],
  directUploadIsUncertain: boolean,
): TopDashboardMultiFileSnapshotTarget | null {
  if (
    directUploadIsUncertain
    || staticFileInputs.length !== 1
  ) return null;
  const input = staticFileInputs[0]!;
  if (
    Object.hasOwn(input, 'multiple')
    || Object.hasOwn(input, 'webkitdirectory')
    || Object.hasOwn(input, 'directory')
  ) {
    return null;
  }
  const id = readDirectTargetAttribute(input, 'id');
  const name = readDirectTargetAttribute(input, 'name');
  if (!id.safe || !name.safe) return null;
  return { id: id.value, name: name.value, index: 0 };
}
