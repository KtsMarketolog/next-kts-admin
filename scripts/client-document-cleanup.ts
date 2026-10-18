import { listPendingClientDocumentCleanup, processClientDocumentCleanup } from '../src/shared/lib/db/clientDocumentCleanupRepo';
import path from 'node:path';

async function main() {
  const args = process.argv.slice(2);
  if (!process.env.DATABASE_URL) throw new Error('Укажите DATABASE_URL явно; файлы окружения автоматически не загружаются.');
  if (args.length === 0) {
    // Read-only inventory of known deletion requests; no schema setup or disk scan.
    console.log(JSON.stringify({ pending: await listPendingClientDocumentCleanup(), limit: 100 }, null, 2));
    return;
  }
  if (args.length !== 3 || args[0] !== '--retry-id' || !/^[1-9]\d*$/.test(args[1]) || args[2] !== '--confirm-file-removal') {
    throw new Error('Просмотр: без аргументов. Повтор одного задания: --retry-id ID --confirm-file-removal');
  }
  const id = Number(args[1]);
  if (!Number.isSafeInteger(id)) throw new Error('Некорректный номер задания');
  if (!process.env.UPLOAD_DIR || !path.isAbsolute(process.env.UPLOAD_DIR)) {
    throw new Error('Для удаления файла укажите UPLOAD_DIR явно как абсолютный путь к рабочему хранилищу.');
  }
  const result = await processClientDocumentCleanup(id);
  console.log(JSON.stringify({ id, ...result }));
  if (result.pending) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Не удалось проверить очистку документов');
  process.exitCode = 1;
}).finally(async () => {
  await globalThis.__ktsPgPool?.end();
});
