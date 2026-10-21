import styles from '@/app/admin/admin.module.scss';
import integrationStyles from './top-dashboard-integration.module.scss';
import { TOP_DASHBOARD_HTML_MAX_MEGABYTES } from '@/shared/lib/topDashboardLimits';
import { requestProfitabilityFrameChange } from '@/features/admin/dashboard-usage/useProfitabilityAuditGuard';
import { UploadFeedbackMessage } from './UploadFeedbackMessage';
import { formatFileSize, formatDate, versionCountLabel } from './topDashboardPresentation';
import type { TopDashboardManagement } from './useTopDashboardManagement';
import type { TopDashboardHtmlVersions } from './useTopDashboardHtmlVersions';
import type { TopDashboardBlockSettings } from './useTopDashboardBlockSettings';

export function TopDashboardHtmlPanel({ management, html, settings }: { management: TopDashboardManagement; html: TopDashboardHtmlVersions; settings: TopDashboardBlockSettings }) {
  const { overview, busyAction, previewFrameRef, setSelectedVersionId, setPreviewRevision } = management;
  const { selectedFile, integrationMode, chooseIntegrationMode, htmlUploadFeedback, fileInputRef, chooseFile, uploadVersion, activateVersion } = html;
  const { isEditingBlockTitle, blockTitleDraft, setBlockTitleDraft, blockMutationError, blockTitleInputRef, renameBlock, deleteBlock, beginBlockTitleEdit, cancelBlockTitleEdit } = settings;
  const activeVersion = overview?.versions.find((version) => version.id === overview.activeVersionId) ?? null;
  const latestDraft = overview?.versions.find((version) => version.status === 'draft');
  return (
      <section id="top-dashboard-html-upload" className={styles.section}>
        <div className={styles.sectionHeader} aria-busy={busyAction === 'rename-block' || busyAction === 'delete-block'}>
          <div className={styles.topDashboardBlockHeading}>
            <p>HTML-дашборд</p>
            {isEditingBlockTitle ? (
              <form className={styles.topDashboardTitleForm} onSubmit={renameBlock}>
                <label htmlFor="top-dashboard-block-title-edit">Название блока</label>
                <div>
                  <input
                    ref={blockTitleInputRef}
                    id="top-dashboard-block-title-edit"
                    type="text"
                    value={blockTitleDraft}
                    maxLength={120}
                    disabled={busyAction !== null}
                    aria-describedby={blockMutationError ? 'top-dashboard-block-mutation-error' : undefined}
                    onChange={(event) => setBlockTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelBlockTitleEdit();
                      }
                    }}
                  />
                  <button type="submit" disabled={busyAction !== null || !blockTitleDraft.trim()}>
                    {busyAction === 'rename-block' ? 'Сохраняем…' : 'Сохранить'}
                  </button>
                  <button
                    className={styles.secondary}
                    type="button"
                    disabled={busyAction !== null}
                    onClick={cancelBlockTitleEdit}
                  >
                    Отмена
                  </button>
                </div>
              </form>
            ) : (
              <div className={styles.topDashboardBlockTitleRow}>
                <h2>{overview?.block.title ?? 'HTML-страница'}</h2>
                {overview ? (
                  <button
                    className={styles.secondary}
                    type="button"
                    disabled={busyAction !== null}
                    onClick={beginBlockTitleEdit}
                  >
                    Изменить название
                  </button>
                ) : null}
              </div>
            )}
          </div>
          <div className={styles.topDashboardBlockHeaderActions}>
            <span className={styles.headingMeta}>{versionCountLabel(overview?.versions.length ?? 0)}</span>
            {overview ? (
              <button
                className={styles.danger}
                type="button"
                disabled={busyAction !== null || isEditingBlockTitle}
                onClick={() => void deleteBlock()}
              >
                {busyAction === 'delete-block' ? 'Удаляем…' : 'Удалить блок'}
              </button>
            ) : null}
          </div>
        </div>

        {blockMutationError ? (
          <p id="top-dashboard-block-mutation-error" className={styles.topDashboardMutationError} role="alert">
            {blockMutationError}
          </p>
        ) : null}

        <fieldset className={integrationStyles.integration} disabled={busyAction !== null || !overview} aria-describedby="top-dashboard-integration-help">
          <legend>Как будет работать новая HTML-версия</legend>
          <div className={integrationStyles.choices}>
            <label className={integrationStyles.choice}>
              <input type="radio" name="top-dashboard-integration-mode" value="standalone" checked={integrationMode === 'standalone'}
                aria-label="Самостоятельный HTML" onChange={() => chooseIntegrationMode('standalone')} />
              <span><strong>Самостоятельный HTML</strong><span>Авторские формы и расчёты. Файлы загружаются внутри отчёта, без общего сохранения на сайте.</span></span>
            </label>
            <label className={integrationStyles.choice}>
              <input type="radio" name="top-dashboard-integration-mode" value="connected" checked={integrationMode === 'connected'}
                aria-label="Общие данные сайта" onChange={() => chooseIntegrationMode('connected')} />
              <span><strong>Общие данные сайта</strong><span>Для совместимых отчётов: один сохранённый набор данных для сотрудников с доступом.</span></span>
            </label>
          </div>
          <p id="top-dashboard-integration-help" className={integrationStyles.hint} aria-live="polite">
            {integrationMode === 'standalone'
              ? 'Обычные обновления оформления и логики не требуют совпадения кода с прошлой версией. Данные внутри HTML сайт автоматически не сохраняет: используйте авторские кнопки сохранения снимка или скачивания перед закрытием. Детальный журнал зависит от подключения HTML.'
              : 'Сайт проверит совместимость полей загрузки и снимков. Сохранённые здесь общие данные доступны всем получателям отчёта. Счета в «Рентабельности» всегда остаются личными и не становятся общими.'}
            {' '}Режим применяется только к новой версии. Перед публикацией проверьте черновик: ошибки самого HTML и недоступные внешние ресурсы сайт не исправляет.
          </p>
        </fieldset>
        <div className={styles.topDashboardUploadCard}>
          <div>
            <h3>Загрузить новую версию</h3>
            <p>Самодостаточный HTML до {TOP_DASHBOARD_HTML_MAX_MEGABYTES} МБ сохранится как черновик. Хранятся действующий и один предыдущий рабочий HTML; неопубликованные черновики — отдельно. Общий лимит блока: 50 версий и 100 МБ.</p>
          </div>
          <div className={styles.topDashboardUploadControls}>
            <label className={styles.topDashboardFilePicker} aria-disabled={busyAction !== null}>
              <span>Выбрать HTML</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".html,.htm,text/html"
                disabled={busyAction !== null}
                aria-describedby={htmlUploadFeedback ? 'top-dashboard-html-upload-feedback' : undefined}
                onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <div className={styles.topDashboardSelectedFile}>
              {selectedFile ? (
                <>
                  <strong>{selectedFile.name}</strong>
                  <span>{formatFileSize(selectedFile.size)}</span>
                </>
              ) : (
                <span>Файл не выбран</span>
              )}
            </div>
            <button type="button" disabled={!selectedFile || busyAction !== null} onClick={uploadVersion}>
              {busyAction === 'upload' ? 'Загружаем…' : 'Загрузить как черновик'}
            </button>
          </div>
          <UploadFeedbackMessage feedback={htmlUploadFeedback} id="top-dashboard-html-upload-feedback" />
        </div>
        <p className={styles.mutedText}>{activeVersion ? `Сейчас опубликован: ${activeVersion.originalName}, версия #${activeVersion.id}.` : 'HTML ещё не опубликован.'}</p>
        {latestDraft ? <article className={styles.topDashboardVersionRow}>
          <div><h3>Последний черновик</h3><div className={styles.topDashboardVersionTitle}><strong>{latestDraft.originalName}</strong></div><p className={styles.mutedText}>Версия #{latestDraft.id} · {formatDate(latestDraft.createdAt)}</p></div>
          <div className={styles.topDashboardVersionActions}>
            <button className={styles.secondary} type="button" disabled={busyAction !== null} onClick={() => {
              if (!requestProfitabilityFrameChange(previewFrameRef.current)) return;
              setSelectedVersionId(latestDraft.id);
              setPreviewRevision((current) => current + 1);
            }}>Предпросмотр черновика</button>
            <button type="button" disabled={busyAction !== null} onClick={() => activateVersion(latestDraft)}>{busyAction === `activate:${latestDraft.id}` ? 'Публикуем…' : 'Опубликовать черновик'}</button>
          </div>
        </article> : null}
      </section>
  );
}
