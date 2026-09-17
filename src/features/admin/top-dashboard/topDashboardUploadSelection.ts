import {
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES,
} from '@/shared/lib/topDashboardMultiFileSnapshot';
import { TOP_DASHBOARD_UPLOAD_MAX_DISCOVERED_TARGETS } from '@/shared/lib/topDashboardLimits';

export type TopDashboardUploadTarget = {
  target: { id: string | null; name: string | null; index: number };
  multiple: boolean;
  directory: boolean;
  accept: string;
  label: string;
};

export function topDashboardUploadTargetKey(target: TopDashboardUploadTarget['target']) {
  return JSON.stringify([target.index, target.id, target.name]);
}

/** Messages from the preview are data, not trusted UI markup. */
export function normalizeTopDashboardUploadTargets(value: unknown): TopDashboardUploadTarget[] {
  if (!Array.isArray(value) || value.length > TOP_DASHBOARD_UPLOAD_MAX_DISCOVERED_TARGETS) return [];
  const keys = new Set<string>();
  const indices = new Set<number>();
  const result: TopDashboardUploadTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    if (!source.target || typeof source.target !== 'object' || Array.isArray(source.target)) return [];
    const target = source.target as Record<string, unknown>;
    if (
      !Number.isSafeInteger(target.index) || Number(target.index) < 0 || Number(target.index) > 0xffff
      || ![target.id, target.name].every((text) => text === null || (
        typeof text === 'string'
        && new TextEncoder().encode(text).length <= TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES
        && !/[\u0000-\u001f\u007f]/u.test(text)
      ))
      || typeof source.multiple !== 'boolean' || typeof source.directory !== 'boolean'
      || typeof source.accept !== 'string' || source.accept.length > 2048
      || typeof source.label !== 'string' || source.label.length > 512
    ) return [];
    const descriptor: TopDashboardUploadTarget = {
      target: { id: target.id as string | null, name: target.name as string | null, index: Number(target.index) },
      multiple: source.multiple,
      directory: source.directory,
      accept: source.accept,
      label: source.label.trim() || `Данные ${result.length + 1}`,
    };
    const key = topDashboardUploadTargetKey(descriptor.target);
    if (keys.has(key) || indices.has(descriptor.target.index)) return [];
    keys.add(key);
    indices.add(descriptor.target.index);
    result.push(descriptor);
  }
  return result;
}
