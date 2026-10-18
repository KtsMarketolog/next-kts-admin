import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import {
  completeInitialSiteContentBootstrap,
  reserveInitialSiteContentBootstrap,
} from '../src/shared/lib/db/schemaSeeds';
import { TransactionCommitUnknownError } from '../src/shared/lib/db/transactionOutcome';

async function main() {
  // Never load .env implicitly: the operator must deliberately select the new database.
  // The confirmation gate precedes every database call, including schema creation.
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--confirm-initial-content') {
    throw new Error('Только для новой установки: задайте DATABASE_URL новой пустой БД и запустите npm run site:seed-content -- --confirm-initial-content до первого запуска сайта.');
  }
  if (!process.env.DATABASE_URL) throw new Error('Укажите DATABASE_URL новой пустой БД явно.');
  const state = await reserveInitialSiteContentBootstrap();
  if (state === 'complete') {
    console.log('Первоначальный контент уже был добавлен. Ничего не изменено; удалённые записи не восстанавливаются.');
    return;
  }
  await ensureSiteSchema();
  const result = await completeInitialSiteContentBootstrap();
  console.log(result === 'seeded'
    ? 'Первоначальные слайды, новости, бренды и группа компаний добавлены одной транзакцией.'
    : 'Первоначальное заполнение уже завершено. Ничего не изменено.');
}

main().catch((error: unknown) => {
  console.error(error instanceof TransactionCommitUnknownError
    ? 'Не удалось подтвердить итог транзакции. Проверьте состояние БД; повтор этой команды безопасен благодаря сохранённой отметке инициализации.'
    : error instanceof Error ? error.message : 'Ошибка первоначального заполнения.');
  process.exitCode = 1;
}).finally(async () => {
  await globalThis.__ktsPgPool?.end();
});
