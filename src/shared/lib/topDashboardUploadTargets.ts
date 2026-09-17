import sanitizeHtml from 'sanitize-html';
import { TOP_DASHBOARD_UPLOAD_MAX_DISCOVERED_TARGETS } from './topDashboardLimits';

import {
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES,
} from './topDashboardMultiFileSnapshot';

export type TopDashboardUploadTarget = {
  target: { id: string | null; name: string | null; index: number };
  multiple: boolean;
  directory: boolean;
  accept: string;
  label: string;
};

const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

function targetText(value: string | undefined) {
  if (!value || value !== value.trim() || UNSAFE_TEXT.test(value)) return null;
  const normalized = value.normalize('NFC');
  return Buffer.byteLength(normalized, 'utf8') <= TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES
    ? normalized
    : null;
}

function displayText(value: string | undefined, maximum = 160) {
  return (value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

/**
 * Static DOM file inputs are independent upload destinations, not a reason to
 * disable the management uploader. Script/template examples and unrelated
 * library calls must not hide actual inputs. Runtime-only inputs are handled
 * by the protected preview, where their real DOM destinations are known.
 */
export function detectTopDashboardUploadTargets(htmlContent: string): TopDashboardUploadTarget[] {
  const inputs: Record<string, string>[] = [];
  const labels = new Map<string, string>();
  try {
    sanitizeHtml(htmlContent, {
      allowedTags: ['label'],
      allowedAttributes: { label: ['for'] },
      nonTextTags: ['script', 'style', 'textarea', 'option', 'title', 'noscript', 'template'],
      transformTags: {
        input: (tagName, attributes) => {
          if (attributes.type?.toLowerCase() === 'file') inputs.push({ ...attributes });
          return { tagName, attribs: attributes };
        },
      },
      exclusiveFilter: (frame) => {
        if (frame.tag === 'label' && frame.attribs.for) {
          const id = targetText(frame.attribs.for);
          const text = displayText(frame.text);
          if (id && text && !labels.has(id)) labels.set(id, text);
        }
        return false;
      },
    });
  } catch {
    return [];
  }

  const ids = inputs.map((input) => targetText(input.id));
  const names = inputs.map((input) => targetText(input.name));
  const countOccurrences = (values: (string | null)[]) => {
    const counts = new Map<string, number>();
    for (const value of values) {
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return counts;
  };
  const idCounts = countOccurrences(ids);
  const nameCounts = countOccurrences(names);
  return inputs.slice(0, TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX + 1).map((input, index) => {
    const rawId = ids[index];
    const rawName = names[index];
    const id = rawId && idCounts.get(rawId) === 1 ? rawId : null;
    const name = rawName && nameCounts.get(rawName) === 1 ? rawName : null;
    return {
      target: { id, name, index },
      multiple: Object.hasOwn(input, 'multiple'),
      directory: Object.hasOwn(input, 'webkitdirectory') || Object.hasOwn(input, 'directory'),
      accept: displayText(input.accept, 512),
      label: displayText(displayText(input['aria-label'])
        || (rawId ? labels.get(rawId) : '')
        || displayText(input.title)
        || rawId
        || rawName
        || `Данные ${index + 1}`),
    };
  }).filter((entry) => !Object.hasOwn(inputs[entry.target.index]!, 'disabled'))
    .slice(0, TOP_DASHBOARD_UPLOAD_MAX_DISCOVERED_TARGETS);
}
