import type { Dispatch, FormEvent, RefObject, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';

import { formatStockLogDate, stockLogStatusClass, stockLogStatusText } from './AdminCatalogHelpers';
import type { StockImportLog } from './AdminCatalogTypes';
import importStyles from './catalog-import.module.scss';

export type CatalogImportError = {
  message: string;
  unchanged?: boolean;
  duplicates?: { article: string; rows: number[]; totalRows: number }[];
  duplicateCount?: number;
  truncated?: boolean;
};

type AdminCatalogImportPanelProps = {
  fileInputRef: RefObject<HTMLInputElement | null>;
  importExcel: (event: FormEvent) => Promise<void>;
  importResult: string;
  importError: CatalogImportError | null;
  fileName: string;
  setFileName: (value: string) => void;
  busyId: string | null;
  stockLogs: StockImportLog[];
  visibleStockLogs: StockImportLog[];
  hiddenStockLogCount: number;
  stockHistoryExpanded: boolean;
  setStockHistoryExpanded: Dispatch<SetStateAction<boolean>>;
  checkStockEmail: () => Promise<void>;
};

export function AdminCatalogImportPanel({
  fileInputRef,
  importExcel,
  importResult,
  importError,
  fileName,
  setFileName,
  busyId,
  stockLogs,
  visibleStockLogs,
  hiddenStockLogCount,
  stockHistoryExpanded,
  setStockHistoryExpanded,
  checkStockEmail,
}: AdminCatalogImportPanelProps) {
  return (
    <>
      <form className={styles.catalogImportCard} onSubmit={importExcel}>
        <div>
          <h3>Загрузка Excel</h3>
          <p>
            Импорт полностью заменяет публичный каталог. Обязательное поле: Артикул. Дополнительно принимаются Модель, EUR, RUB,
            CNY, Общая скидка, Ручная скидка и Ручная скидка роп.
          </p>
          {importResult && <span>{importResult}</span>}
        </div>
        <label className={styles.fileInput}>
          {fileName || 'Выбрать Excel'}
          <input
            ref={fileInputRef}
            type="file"
            disabled={busyId !== null}
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            onChange={(event) => setFileName(event.target.files?.[0]?.name ?? '')}
          />
        </label>
        <button disabled={busyId !== null}>{busyId === 'import' ? 'Загрузка...' : 'Загрузить Excel'}</button>
        {importError && <div className={importStyles.error} role="alert" aria-labelledby="catalog-import-error-title">
          <h4 id="catalog-import-error-title">{importError.unchanged ? 'Импорт остановлен' : 'Ошибка загрузки Excel'}</h4>
          <p>{importError.message}</p>
          {importError.unchanged && <p className={importStyles.unchanged}>Каталог, остатки и прайсы не изменены.</p>}
          {importError.duplicates && <>
            <p>Артикулов с повторами: <strong>{importError.duplicateCount ?? importError.duplicates.length}</strong>.
              {(importError.duplicateCount ?? 0) > importError.duplicates.length && <> Показано: {importError.duplicates.length}.</>}</p>
            <ul className={importStyles.duplicates} tabIndex={0} aria-label="Повторяющиеся артикулы и строки Excel">
              {importError.duplicates.map((duplicate, index) => <li key={`${duplicate.article}-${index}`}>
                <strong>Артикул: <code>{duplicate.article}</code></strong>
                <p>Строки Excel: {duplicate.rows.join(', ')}{duplicate.totalRows > duplicate.rows.length
                  ? ` (показано ${duplicate.rows.length} из ${duplicate.totalRows})` : ''}.</p>
              </li>)}
            </ul>
            {importError.truncated && <p>Список сокращён. После исправления повторите загрузку для полной проверки.</p>}
            <p>Исправьте повторы в Excel, выберите исправленный файл и загрузите его снова. Существующие записи автоматически не удаляются.</p>
          </>}
        </div>}
      </form>

      <div className={styles.catalogImportCard}>
        <div>
          <h3>Импорт остатков</h3>
          <p>
            Проверяет последние письма, включая прочитанные, и обновляет только остаток, ожидание поступления и дату
            обновления. Товары не создаются.
          </p>
          {stockLogs[0] && (
            <span>
              Последний импорт: {stockLogs[0].status}, обновлено {stockLogs[0].updatedRows} из {stockLogs[0].totalRows}
            </span>
          )}
        </div>
        <div>
          <p>
            Файл .xlsx: Остатки*.xlsx, колонки Номенклатура.Код, Сейчас, Ожидается и Ед. изм. Артикул в каталоге должен
            совпадать с Номенклатура.Код.
          </p>
        </div>
        <button type="button" disabled={busyId !== null} onClick={checkStockEmail}>
          {busyId === 'stock-email' ? 'Проверка...' : 'Проверить почту сейчас'}
        </button>
      </div>

      {stockLogs.length > 0 && (
        <div className={styles.stockLogCard}>
          <div className={styles.stockLogHeader}>
            <div>
              <h3>История импорта остатков</h3>
              <p>Последние проверки почты и результаты обновления остатков.</p>
            </div>
            <div className={styles.stockLogHeaderActions}>
              <span className={styles.stockLogCount}>{stockLogs.length}</span>
              {hiddenStockLogCount > 0 && (
                <button type="button" className={styles.stockLogToggle} onClick={() => setStockHistoryExpanded((current) => !current)}>
                  {stockHistoryExpanded ? 'Скрыть историю' : `Показать ещё ${hiddenStockLogCount}`}
                </button>
              )}
            </div>
          </div>

          <div className={styles.stockLogList}>
            {visibleStockLogs.map((log) => (
              <article className={styles.stockLogItem} key={log.logId ?? `${log.createdAt}-${log.fileName}`}>
                <div className={styles.stockLogMain}>
                  <div>
                    <strong className={styles.stockLogFile}>{log.fileName || 'Файл без названия'}</strong>
                    <span className={styles.stockLogMeta}>{formatStockLogDate(log.createdAt)}</span>
                  </div>
                  <span className={`${styles.stockLogStatus} ${stockLogStatusClass(log.status)}`}>
                    {stockLogStatusText(log.status)}
                  </span>
                </div>

                <div className={styles.stockLogMetrics}>
                  <div className={styles.stockLogMetric}>
                    <span>Строк</span>
                    <strong>{log.totalRows}</strong>
                  </div>
                  <div className={styles.stockLogMetric}>
                    <span>Обновлено</span>
                    <strong>{log.updatedRows}</strong>
                  </div>
                  <div className={styles.stockLogMetric}>
                    <span>Не найдено</span>
                    <strong>{log.notFoundRows}</strong>
                  </div>
                  <div className={styles.stockLogMetric}>
                    <span>Ошибок</span>
                    <strong>{log.failedRows}</strong>
                  </div>
                </div>

                {log.errors.length > 0 && (
                  <details className={styles.stockLogErrors}>
                    <summary>Показать ошибки</summary>
                    <ul>
                      {log.errors.slice(0, 5).map((error, index) => (
                        <li key={`${log.logId ?? log.createdAt}-${index}`}>
                          Строка {error.row}: {error.name || 'без названия'} - {error.error}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
