import { type RefObject } from 'react';
import styles from '@/app/admin/admin.module.scss';
import { TOP_DASHBOARD_DATA_MAX_MEGABYTES, TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_LABEL } from '@/shared/lib/topDashboardLimits';
import { requestProfitabilityFrameChange } from '@/features/admin/dashboard-usage/useProfitabilityAuditGuard';
import { DashboardDataDates } from './DashboardDataDates';
import { UploadFeedbackMessage } from './UploadFeedbackMessage';
import { formatFileSize, snapshotFormatLabel, storedSizeLabel, versionCountLabel } from './topDashboardPresentation';
import { topDashboardUploadTargetKey } from './topDashboardUploadSelection';
import { selectWorkingVersionPair } from './topDashboardHistory';
import type { TopDashboardManagement } from './useTopDashboardManagement';
import type { TopDashboardDataVersions } from './useTopDashboardDataVersions';

export function TopDashboardDataPanel({ management, data, previewCardRef }: { management: TopDashboardManagement; data: TopDashboardDataVersions; previewCardRef: RefObject<HTMLElement | null> }) {
  const { overview, busyAction, previewFrameRef, selectedVersionId, setSelectedVersionId } = management;
  const { activeDataVersion, hasActiveHtml, isProfitabilityReport, isUnsupportedProfitability, activeDataContractMatches, usesUniversalDataUpload, dataUploadTargets, canUploadData, selectedTargetFiles, selectedDataFile, selectedFileCount, selectedFilesSize, uploadSelectionRevision, dataUploadFeedback, dataFileInputRef, chooseTargetFiles, chooseDataFile, uploadDataVersion, probeRuntimeUploadTargets } = data;
  const workingDataVersions = overview ? selectWorkingVersionPair(overview.data.versions, overview.data.activeVersionId, overview.data.previousVersionId) : [];
  return (
      <section
        id="top-dashboard-data-upload"
        className={`${styles.section} ${styles.topDashboardDataSection}`}
        aria-busy={busyAction === 'upload-data' || busyAction?.startsWith('activate-data:')}
      >
        <div className={styles.sectionHeader}>
          <div>
            <p>{isProfitabilityReport ? 'Локальные счета' : 'Общие данные'}</p>
            <h2>Данные дашборда</h2>
          </div>
          <span className={styles.headingMeta}>{versionCountLabel(workingDataVersions.length)}</span>
        </div>

        <p className={styles.topDashboardDataIntro}>
          {isUnsupportedProfitability
            ? 'Эта версия «Рентабельности счетов» требует адаптации журнала. Загрузка счетов отключена, чтобы не распространять личные файлы среди других сотрудников и не пропускать детализацию.'
            : isProfitabilityReport
            ? 'Загружайте счета и снимки кнопками внутри отчёта выше. Эти файлы используются только в открытом отчёте сотрудника и не становятся общими для всех.'
            : hasActiveHtml
            ? 'Сохранённый файл автоматически откроется в дашборде у всех пользователей с доступом. Новый файл сразу заменит текущие данные, а предыдущая версия останется доступна для отката.'
            : 'Сначала опубликуйте HTML-страницу. После этого здесь можно будет сохранить подходящий файл данных для всех пользователей.'}
        </p>

        <div className={`${styles.topDashboardUploadCard} ${styles.topDashboardDataUploadCard}`}>
          <div>
            <h3>{isProfitabilityReport ? 'Загрузка счетов внутри отчёта' : activeDataVersion ? 'Обновить данные' : 'Загрузить данные'}</h3>
            {!hasActiveHtml ? (
              <p>
                Сначала опубликуйте HTML-страницу, затем здесь появится подходящий способ загрузки данных.
              </p>
            ) : overview && !activeDataContractMatches ? (
              <p>
                Данные о текущей HTML-странице устарели. Обновите страницу перед загрузкой файла.
              </p>
            ) : isUnsupportedProfitability ? (
              <p role="alert">Детализация для этой версии не подключена. Передайте авторский HTML для адаптации. Ранее записанные события остаются в журнале до окончания срока хранения.</p>
            ) : isProfitabilityReport ? (
              <p>Успешная загрузка счёта фиксируется в журнале: сотрудник, время, номер, номенклатура, количество, сумма и исходная валюта. Журнал доступен админу, TOP и админу TOP; хранение — один месяц.</p>
            ) : overview?.activeDataContract.mode === 'disabled' ? (
              <p>
                В опубликованной HTML-странице не найдено поле для загрузки данных.
                Опубликуйте исправленную версию HTML, чтобы подключить общий файл.
              </p>
            ) : usesUniversalDataUpload && !dataUploadTargets.length ? (
              <p>
                Поля загрузки определяются в опубликованном отчёте. Откройте его просмотр выше;
                если поле создаётся после действия в отчёте, оно появится здесь после этого действия.
              </p>
            ) : usesUniversalDataUpload ? (
              <p>
                Выберите файл, несколько файлов или папку для нужного поля отчёта.
                Общий размер — до {TOP_DASHBOARD_DATA_MAX_MEGABYTES} МБ.
                Файлы передаются в HTML без изменения. Выбранный набор заменит текущие данные целиком.
                Если отчёту нужны несколько файлов, выберите их все. Предыдущая версия останется для отката.
              </p>
            ) : (
              <p>
                Поддерживаются снимки .json и .json.gz размером до{' '}
                {TOP_DASHBOARD_DATA_MAX_MEGABYTES} МБ. Для .json.gz размер после распаковки — до{' '}
                {TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_LABEL}. HTML-страницу повторно загружать не нужно.
              </p>
            )}
          </div>
          {isProfitabilityReport ? null : usesUniversalDataUpload ? (
            <div className={styles.topDashboardMultiUploadControls}>
              {dataUploadTargets.map((descriptor) => {
                const key = topDashboardUploadTargetKey(descriptor.target);
                const files = selectedTargetFiles[key] ?? [];
                return (
                  <div className={styles.topDashboardUploadTarget} key={`${uploadSelectionRevision}:${key}`}>
                    <strong>{descriptor.label}</strong>
                    <div className={styles.topDashboardUploadTargetControls}>
                      <label className={styles.topDashboardFilePicker} aria-disabled={busyAction !== null || !canUploadData}>
                        <span>{descriptor.directory ? 'Выбрать папку' : descriptor.multiple ? 'Выбрать файлы' : 'Выбрать данные'}</span>
                        <input
                          type="file"
                          aria-label={`${descriptor.directory ? 'Выбрать папку' : 'Выбрать данные'}: ${descriptor.label}`}
                          accept={descriptor.accept || undefined}
                          multiple={descriptor.multiple || descriptor.directory}
                          ref={(input) => {
                            if (input && descriptor.directory) input.setAttribute('webkitdirectory', '');
                          }}
                          disabled={busyAction !== null || !canUploadData}
                          aria-describedby={dataUploadFeedback ? 'top-dashboard-data-upload-feedback' : undefined}
                          onChange={(event) => {
                            chooseTargetFiles(descriptor, Array.from(event.target.files ?? []));
                            event.target.value = '';
                          }}
                        />
                      </label>
                      <div className={styles.topDashboardSelectedFile} aria-live="polite">
                        {files.length ? (
                          <>
                            <strong title={files.map((file) => file.webkitRelativePath || file.name).join('\n')}>
                              {files.length === 1 ? files[0].name : `Файлов выбрано: ${files.length}`}
                            </strong>
                            <span>{formatFileSize(files.reduce((size, file) => size + file.size, 0))}</span>
                          </>
                        ) : <span>{descriptor.directory ? 'Папка не выбрана' : 'Файлы не выбраны'}</span>}
                      </div>
                      {files.length > 0 ? (
                        <button
                          type="button"
                          className={styles.secondary}
                          disabled={busyAction !== null}
                          onClick={() => chooseTargetFiles(descriptor, [])}
                          aria-label={`Убрать выбранные файлы: ${descriptor.label}`}
                        >Убрать</button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {!dataUploadTargets.length && hasActiveHtml ? (
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={busyAction !== null}
                  onClick={() => {
                    if (!requestProfitabilityFrameChange(previewFrameRef.current)) return;
                    setSelectedVersionId(overview!.activeVersionId);
                    if (selectedVersionId === overview!.activeVersionId) probeRuntimeUploadTargets();
                    previewCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >Открыть опубликованный отчёт</button>
              ) : null}
              {dataUploadTargets.length > 0 ? (
                <div className={styles.topDashboardUploadTargetFooter}>
                  <span aria-live="polite">Выбрано файлов: {selectedFileCount} · {formatFileSize(selectedFilesSize)}</span>
                  <button
                    type="button"
                    disabled={!selectedFileCount || busyAction !== null || !canUploadData}
                    onClick={() => void uploadDataVersion()}
                  >{busyAction === 'upload-data' ? 'Сохраняем…' : activeDataVersion ? 'Заменить для всех' : 'Сохранить для всех'}</button>
                </div>
              ) : null}
            </div>
          ) : <div className={styles.topDashboardUploadControls}>
            <label className={styles.topDashboardFilePicker} aria-disabled={busyAction !== null || !overview || !canUploadData}>
              <span>Выбрать данные</span>
              <input
                ref={dataFileInputRef}
                type="file"
                accept={usesUniversalDataUpload
                  ? undefined
                  : '.json,.json.gz,application/json,application/gzip'}
                disabled={busyAction !== null || !overview || !canUploadData}
                aria-describedby={dataUploadFeedback ? 'top-dashboard-data-upload-feedback' : undefined}
                onChange={(event) => chooseDataFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <div className={styles.topDashboardSelectedFile}>
              {selectedDataFile ? (
                <>
                  <strong>{selectedDataFile.name}</strong>
                  <span>{formatFileSize(selectedDataFile.size)}</span>
                </>
              ) : (
                <span>Файл не выбран</span>
              )}
            </div>
            <button
              type="button"
              disabled={!selectedDataFile || busyAction !== null || !overview || !canUploadData}
              onClick={() => void uploadDataVersion()}
            >
              {busyAction === 'upload-data'
                ? 'Сохраняем…'
                : activeDataVersion
                  ? 'Заменить для всех'
                  : 'Сохранить для всех'}
            </button>
          </div>}
          <UploadFeedbackMessage feedback={dataUploadFeedback} id="top-dashboard-data-upload-feedback" />
        </div>

        {isProfitabilityReport ? null : activeDataVersion ? (
          <article className={styles.topDashboardActiveDataCard}>
            <div>
              <span className={styles.topDashboardDataCardEyebrow}>Сейчас используется</span>
              <div className={styles.topDashboardVersionTitle}>
                <strong>{activeDataVersion.originalName}</strong>
                <span className={`${styles.topDashboardStatus} ${styles.topDashboardStatusactive}`}>
                  Активные данные
                </span>
              </div>
              <div className={styles.topDashboardMeta}>
                <span>{snapshotFormatLabel(activeDataVersion.snapshotFormat)}</span>
                <span>Файл: {formatFileSize(activeDataVersion.fileSize)}</span>
                <span>{storedSizeLabel(activeDataVersion)}</span>
                <span>Загрузил: {activeDataVersion.uploadedByName || 'Администратор'}</span>
                <DashboardDataDates uploadedAt={activeDataVersion.createdAt} dataAsOf={activeDataVersion.dataAsOf} />
                <span>SHA-256: {activeDataVersion.sha256.slice(0, 12)}…</span>
              </div>
            </div>
          </article>
        ) : (
          <div className={styles.topDashboardDataEmpty}>
            <strong>Данные ещё не загружены</strong>
            <span>Выберите снимок выше. После сохранения другим пользователям не придётся выбирать его заново.</span>
          </div>
        )}

      </section>
  );
}
