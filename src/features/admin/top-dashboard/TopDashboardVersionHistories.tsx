import styles from '@/app/admin/admin.module.scss';
import { requestProfitabilityFrameChange } from '@/features/admin/dashboard-usage/useProfitabilityAuditGuard';
import { formatFileSize, formatDate, statusLabel, dataStatusLabel, snapshotFormatLabel, storedSizeLabel } from './topDashboardPresentation';
import { selectWorkingVersionPair } from './topDashboardHistory';
import type { TopDashboardManagement } from './useTopDashboardManagement';
import type { TopDashboardHtmlVersions } from './useTopDashboardHtmlVersions';
import type { TopDashboardDataVersions } from './useTopDashboardDataVersions';

export function TopDashboardVersionHistories({ management, html, data }: { management: TopDashboardManagement; html: TopDashboardHtmlVersions; data: TopDashboardDataVersions }) {
  const { overview, busyAction, selectedVersionId, setSelectedVersionId, setPreviewRevision, previewFrameRef } = management;
  const { activateVersion, deleteVersion } = html;
  const { activateDataVersion, hasActiveHtml, isLocalDataReport } = data;
  const activeVersion = overview?.versions.find((version) => version.id === overview.activeVersionId) ?? null;
  const workingHtmlVersions = overview ? selectWorkingVersionPair(overview.versions, overview.activeVersionId, overview.previousVersionId) : [];
  const workingDataVersions = overview ? selectWorkingVersionPair(overview.data.versions, overview.data.activeVersionId, overview.data.previousVersionId) : [];
  return <>
      {!isLocalDataReport && <section id="top-dashboard-data-history" className={styles.section}>
        <p className={styles.mutedText}>Хранятся текущий и один предыдущий рабочий снимок данных.</p>
        {overview && workingDataVersions.length ? (
          <div className={styles.topDashboardDataHistory}>
            <div className={styles.topDashboardDataHistoryHeader}>
              <h3>История данных</h3>
              {overview.data.previousVersionId ? (
                <span>Предыдущая версия #{overview.data.previousVersionId}</span>
              ) : null}
            </div>
            <div className={styles.topDashboardVersionList}>
              {workingDataVersions.map((version) => (
                <article className={styles.topDashboardVersionRow} key={version.id}>
                  <div>
                    <div className={styles.topDashboardVersionTitle}>
                      <strong>{version.originalName}</strong>
                      <span className={`${styles.topDashboardStatus} ${styles[`topDashboardStatus${version.status}`]}`}>
                        {dataStatusLabel(version.status)}
                      </span>
                    </div>
                    <div className={styles.topDashboardMeta}>
                      <span>Версия данных #{version.id}</span>
                      <span>{snapshotFormatLabel(version.snapshotFormat)}</span>
                      <span>Файл: {formatFileSize(version.fileSize)}</span>
                      <span>{storedSizeLabel(version)}</span>
                      <span>Загрузил: {version.uploadedByName || 'Администратор'}</span>
                      <span>{formatDate(version.createdAt)}</span>
                    </div>
                  </div>
                  {version.status !== 'active' ? (
                    <div className={styles.topDashboardVersionActions}>
                      <button
                        type="button"
                        disabled={busyAction !== null || !hasActiveHtml}
                        onClick={() => void activateDataVersion(version)}
                      >
                        {busyAction === `activate-data:${version.id}` ? 'Возвращаем…' : 'Откатить данные'}
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </section>}

      <section id="top-dashboard-html-history" className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <p>История</p>
            <h2>Версии и откат</h2>
          </div>
          {activeVersion ? <span className={styles.headingMeta}>Активна #{activeVersion.id}</span> : null}
        </div>

        {overview?.versions.length ? (
          <div className={styles.topDashboardVersionList}>
            <p className={styles.mutedText}>Хранятся действующий и один предыдущий рабочий HTML. Черновики перечислены отдельно.</p>
            {[
              { title: 'Рабочие HTML-версии', versions: workingHtmlVersions },
              { title: 'Черновики HTML', versions: overview.versions.filter((version) => version.status === 'draft') },
            ].filter((group) => group.versions.length).map((group) => <section key={group.title}>
              <h3>{group.title}</h3>
              <div className={styles.topDashboardVersionList}>
                {group.versions.map((version) => (
                  <article
                    className={`${styles.topDashboardVersionRow} ${version.id === selectedVersionId ? styles.topDashboardVersionSelected : ''}`}
                    key={version.id}
                  >
                    <div>
                      <div className={styles.topDashboardVersionTitle}>
                        <strong>{version.originalName}</strong>
                        <span className={`${styles.topDashboardStatus} ${styles[`topDashboardStatus${version.id === overview.previousVersionId ? 'previous' : version.status}`]}`}>
                          {statusLabel(version.id === overview.previousVersionId ? 'previous' : version.status)}
                        </span>
                      </div>
                      <div className={styles.topDashboardMeta}>
                        <span>Версия #{version.id}</span>
                        <span>{formatFileSize(version.fileSize)}</span>
                        <span>Загрузил: {version.uploadedByName || 'Администратор'}</span>
                        <span>{formatDate(version.createdAt)}</span>
                        {version.firstPublishedAt ? <span>Первая публикация: {formatDate(version.firstPublishedAt)}</span> : null}
                      </div>
                    </div>
                    <div className={styles.topDashboardVersionActions}>
                      <button
                        className={styles.secondary}
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => {
                          if (!requestProfitabilityFrameChange(previewFrameRef.current)) return;
                          setSelectedVersionId(version.id);
                          setPreviewRevision((current) => current + 1);
                        }}
                      >
                        Предпросмотр
                      </button>
                      {version.status !== 'active' ? (
                        <>
                          <button type="button" disabled={busyAction !== null} onClick={() => activateVersion(version)}>
                            {busyAction === `activate:${version.id}`
                              ? 'Публикуем…'
                              : version.status === 'archived'
                                ? 'Откатить'
                                : 'Опубликовать'}
                          </button>
                          <button
                            className={styles.danger}
                            type="button"
                            disabled={busyAction !== null}
                            onClick={() => deleteVersion(version)}
                          >
                            {busyAction === `delete:${version.id}` ? 'Удаляем…' : 'Удалить'}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>)}
          </div>
        ) : (
          <p className={styles.mutedText}>История появится после первой загрузки HTML.</p>
        )}
      </section>
  </>;
}
