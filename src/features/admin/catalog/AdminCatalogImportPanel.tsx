import type { Dispatch, FormEvent, RefObject, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';

import { formatStockLogDate, stockLogStatusClass, stockLogStatusText } from './AdminCatalogHelpers';
import type { StockImportLog } from './AdminCatalogTypes';

type AdminCatalogImportPanelProps = {
  fileInputRef: RefObject<HTMLInputElement | null>;
  importExcel: (event: FormEvent) => Promise<void>;
  importResult: string;
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
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            onChange={(event) => setFileName(event.target.files?.[0]?.name ?? '')}
          />
        </label>
        <button disabled={busyId === 'import'}>{busyId === 'import' ? 'Загрузка...' : 'Загрузить Excel'}</button>
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
        <button type="button" disabled={busyId === 'stock-email'} onClick={checkStockEmail}>
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
