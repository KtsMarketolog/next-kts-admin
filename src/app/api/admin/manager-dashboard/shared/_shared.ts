import { personalJson, requirePersonalAccess } from '../_shared';

/** A shared report is an explicitly separate scope, never an alternative manager ID. */
export async function requireSharedAccess(request?: Request, manageOnly = false) {
  const access = await requirePersonalAccess(request, manageOnly);
  if (access.denied) return access;
  if (access.mode === 'view' && access.manager?.role !== 'support_manager') {
    return {denied: personalJson({error: 'Общий отчёт доступен только менеджерам по сопровождению'}, 403)} as const;
  }
  return access;
}

export function sharedQuery(request: Request, allowed: readonly string[]) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => !allowed.includes(key) || query.getAll(key).length !== 1)) return null;
  if (query.has('preview') && query.get('preview') !== '1') return null;
  return query;
}
