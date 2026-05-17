import { usePathname, useSearchParams } from 'next/navigation';

export type AdminWholesaleScreen =
  | 'admin'
  | 'managerAnalytics'
  | 'managerDetail'
  | 'manager'
  | 'create'
  | 'edit'
  | 'home';

export function useAdminWholesaleGatewayPath(canManageWholesale: boolean) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const normalizedPathname = pathname ?? '';
  const startsInEditor = normalizedPathname.endsWith('/create') || /\/admin\/wholesale\/\d+\/edit$/.test(normalizedPathname);

  const editMatch = normalizedPathname.match(/\/admin\/wholesale\/(\d+)\/edit$/);
  const editId = editMatch ? Number(editMatch[1]) : null;
  const managerAnalyticsMatch = normalizedPathname.match(/\/admin\/wholesale\/admin\/managers\/(\d+)\/analytics$/);
  const managerAnalyticsId = managerAnalyticsMatch ? Number(managerAnalyticsMatch[1]) : null;
  const managerDetailMatch = normalizedPathname.match(/\/admin\/wholesale\/admin\/managers\/(\d+)$/);
  const managerDetailId = managerDetailMatch ? Number(managerDetailMatch[1]) : null;
  const screen: AdminWholesaleScreen = normalizedPathname.endsWith('/admin')
    ? 'admin'
    : managerAnalyticsId
      ? 'managerAnalytics'
      : managerDetailId
        ? 'managerDetail'
        : normalizedPathname.endsWith('/manager')
          ? 'manager'
          : normalizedPathname.endsWith('/create')
            ? 'create'
            : editId
              ? 'edit'
              : 'home';

  const analyticsManagerIdParam = Number(searchParams.get('analyticsManagerId'));
  const createManagerIdParam = Number(searchParams.get('managerId'));
  const createManagerId = Number.isInteger(createManagerIdParam) && createManagerIdParam > 0 ? createManagerIdParam : null;
  const analyticsBackHref =
    canManageWholesale && screen === 'edit' && Number.isInteger(analyticsManagerIdParam) && analyticsManagerIdParam > 0
      ? `/admin/wholesale/admin/managers/${analyticsManagerIdParam}/analytics`
      : null;
  const editorBackHref =
    analyticsBackHref ??
    (canManageWholesale && screen === 'create' && createManagerId ? `/admin/wholesale/admin/managers/${createManagerId}` : '/admin/wholesale/manager');

  return {
    analyticsBackHref,
    createManagerId,
    editId,
    editorBackHref,
    managerAnalyticsId,
    managerDetailId,
    screen,
    startsInEditor,
  };
}
