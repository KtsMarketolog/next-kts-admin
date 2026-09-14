import { importStockFromEmail } from '../src/entities/catalog/api/stockImport';

async function main() {
  const result = await importStockFromEmail();

  if (result.status === 'busy') {
    console.log('Импорт остатков уже выполняется. Повторная проверка пропущена; письма не изменены.');
    return;
  }

  if (!result.processed || !result.result) {
    console.log('Новых писем с остатками нет.');
    return;
  }

  const importResult = result.result;
  console.log(
    [
      `Импорт остатков: ${importResult.status}`,
      `файл: ${importResult.fileName}`,
      `строк: ${importResult.totalRows}`,
      `обновлено: ${importResult.updatedRows}`,
      `не найдено: ${importResult.notFoundRows}`,
      `ошибок: ${importResult.failedRows}`,
    ].join('; '),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
