import type { DashboardAccessOption } from '@/shared/lib/dashboardAccess';

/** A partial/old API response must not turn an existing grant list into an empty one. */
export function readDashboardOptions(value: unknown): DashboardAccessOption[] | null {
  if (!Array.isArray(value)) return null;
  const keys = new Set<string>();
  const options: DashboardAccessOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object'
      || typeof item.key !== 'string' || !item.key
      || typeof item.title !== 'string' || !item.title.trim()
      || keys.has(item.key)) return null;
    keys.add(item.key);
    options.push({
      key: item.key,
      title: item.title,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(typeof item.href === 'string' ? { href: item.href } : {}),
    });
  }
  return options;
}

export function toggleDashboardAccess(current: string[], key: string, checked: boolean): string[] {
  const next = new Set(current);
  if (checked) next.add(key);
  else next.delete(key);
  return [...next];
}
