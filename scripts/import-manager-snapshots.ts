import { importManagerDashboardFromEmail } from '../src/shared/lib/managerDashboardMail';

importManagerDashboardFromEmail().then((result) => {
  console.log(JSON.stringify(result));
  if (result.failed > 0) process.exitCode = 1;
}).catch(() => {
  console.error('Не удалось проверить почту персональных дашбордов. Проверьте настройки и повторите попытку.');
  process.exitCode = 1;
});
