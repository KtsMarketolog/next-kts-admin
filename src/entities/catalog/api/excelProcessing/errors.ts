export class ExcelResourceLimitError extends Error {
  readonly code = 'EXCEL_RESOURCE_LIMIT';
  readonly status = 413;
  constructor(message: string) {
    super(`${message} Файл не импортирован, действующие данные не изменены.`);
    this.name = 'ExcelResourceLimitError';
  }
}

export type ExcelProcessingErrorCode = 'EXCEL_PROCESSING_BUSY' | 'EXCEL_PROCESSING_TIMEOUT' | 'EXCEL_PROCESSING_ABORTED' | 'EXCEL_PROCESSING_FAILED';

export class ExcelProcessingError extends Error {
  readonly status: 408 | 503;
  constructor(readonly code: ExcelProcessingErrorCode) {
    super({
      EXCEL_PROCESSING_BUSY: 'Другой Excel-файл уже обрабатывается. Повторите загрузку немного позже.',
      EXCEL_PROCESSING_TIMEOUT: 'Обработка Excel-файла заняла слишком много времени. Файл не импортирован, действующие данные не изменены.',
      EXCEL_PROCESSING_ABORTED: 'Загрузка Excel-файла отменена. Файл не импортирован, действующие данные не изменены.',
      EXCEL_PROCESSING_FAILED: 'Сервис обработки Excel не смог завершить проверку файла. Повторите попытку; если ошибка повторяется, передайте файл администратору для проверки. Файл не импортирован, действующие данные не изменены.',
    }[code]);
    this.name = 'ExcelProcessingError';
    this.status = code === 'EXCEL_PROCESSING_BUSY' || code === 'EXCEL_PROCESSING_FAILED' ? 503 : 408;
  }
}
