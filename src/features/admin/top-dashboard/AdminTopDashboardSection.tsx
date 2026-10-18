'use client';

import { useMemo, useRef } from 'react';
import styles from '@/app/admin/admin.module.scss';
import { useDashboardUsage } from '@/features/admin/dashboard-usage/useDashboardUsage';
import { DashboardAudienceEditor } from '@/features/admin/dashboard-access/DashboardAudienceEditor';
import { DashboardInstructions } from '@/features/admin/dashboard-instructions/DashboardInstructions';
import { useTopDashboardDownloadBridge } from './useTopDashboardDownloadBridge';
import { useTopDashboardManagement } from './useTopDashboardManagement';
import { useTopDashboardHtmlVersions } from './useTopDashboardHtmlVersions';
import { useTopDashboardDataVersions } from './useTopDashboardDataVersions';
import { useTopDashboardBlockSettings } from './useTopDashboardBlockSettings';
import { TopDashboardManagementPreview } from './TopDashboardManagementPreview';
import { TopDashboardDataPanel } from './TopDashboardDataPanel';
import { TopDashboardHtmlPanel } from './TopDashboardHtmlPanel';
import { TopDashboardVersionHistories } from './TopDashboardVersionHistories';

type AdminTopDashboardSectionProps = {
  canAssignAccess?: boolean;
  blockId: number;
  showStatus: (message: string) => void;
};

export function AdminTopDashboardSection({ blockId, showStatus, canAssignAccess = false }: AdminTopDashboardSectionProps) {
  const previewFrameRef = useTopDashboardDownloadBridge(showStatus);
  const previewCardRef = useRef<HTMLElement>(null);
  const management = useTopDashboardManagement(blockId, previewFrameRef, showStatus);
  const html = useTopDashboardHtmlVersions(management);
  const data = useTopDashboardDataVersions(management);
  const settings = useTopDashboardBlockSettings(management);
  const { overview, selectedVersionId, busyAction, loadError, router, cancelAll } = management;
  const selectedVersion = useMemo(
    () => overview?.versions.find((version) => version.id === selectedVersionId) ?? null,
    [overview, selectedVersionId],
  );
  useDashboardUsage({ dashboardKey: `top:${blockId}`, iframeRef: previewFrameRef,
    preview: selectedVersion?.status !== 'active', versionId: selectedVersion?.id ?? null });
  const cancelPendingOperation = () => { cancelAll(); data.cancelPendingUpload(); };

  if (loadError && !overview) {
    return (
      <section className={`${styles.section} ${styles.topDashboardLoadError}`} role="alert">
        <span className={styles.topDashboardEyebrow}>HTML-дашборд</span>
        <h2>Страница не открылась</h2>
        <p>{loadError}</p>
        <button type="button" onClick={() => router.push('/admin/top', { scroll: false })}>
          Вернуться к списку HTML-страниц
        </button>
      </section>
    );
  }

  return (
    <div className={styles.topDashboardLayout}>
      {busyAction ? <div role="status"><button type="button" className={styles.secondary} onClick={cancelPendingOperation}>Прервать ожидание</button><p>Прерывание ожидания не отменяет уже сохранённые данные. Перед повторной отправкой проверьте историю.</p></div> : null}
      <TopDashboardManagementPreview management={management} html={html} data={data} selectedVersion={selectedVersion} previewCardRef={previewCardRef} />
      {overview?.instruction === 'sales-analytics' ? <DashboardInstructions dashboardKey={`top:${blockId}`} kind={overview.instruction} /> : null}
      <TopDashboardDataPanel management={management} data={data} previewCardRef={previewCardRef} />
      <TopDashboardHtmlPanel management={management} html={html} settings={settings} />
      {canAssignAccess ? <DashboardAudienceEditor dashboardKey={`top:${blockId}`} /> : null}
      <TopDashboardVersionHistories management={management} html={html} data={data} />
    </div>
  );
}
