import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { getPriceRequestInbox } from '@/shared/lib/db/clientPriceRequestsRepo';
import { ClientPriceRequestList } from '@/features/client-requests/ClientPriceRequestList';
import styles from '../../admin.module.scss';
import inboxStyles from './requests.module.scss';

export const dynamic = 'force-dynamic';

export default async function PriceRequestsPage({ searchParams }: { searchParams: Promise<{ before?: string; pending?: string }> }) {
  const session = await getAdminSession();
  if (!session) redirect('/login?mode=employee');
  if (session.role !== 'admin' && session.role !== 'wholesale_admin') redirect('/admin');
  const params = await searchParams;
  const before = typeof params.before === 'string' && /^[1-9][0-9]{0,17}$/.test(params.before) ? params.before : null;
  const pendingOnly = params.pending === '1';
  const data = await getPriceRequestInbox(session, before, pendingOnly);
  return <main className={styles.page}><section className={styles.section}>
    <div className={inboxStyles.header}>
      <div><p>Индивидуальные прайсы</p><h1>Заявки из прайсов</h1></div>
      <Link className={inboxStyles.link} href="/admin/wholesale">Вернуться к прайсам</Link>
    </div>
    <p>Заявки сохраняются до отправки почты, включая прайсы без привязки к компании. При сбое почты уведомления остаются в очереди и повторяются автоматически.</p>
    <nav className={inboxStyles.navigation} aria-label="Фильтр заявок"><Link className={inboxStyles.link} href="/admin/wholesale/requests" aria-current={!pendingOnly ? 'page' : undefined}>Все заявки</Link>
      <Link className={inboxStyles.link} href="/admin/wholesale/requests?pending=1" aria-current={pendingOnly ? 'page' : undefined}>Почта ожидает отправки</Link></nav>
    <ClientPriceRequestList requests={data.requests} showClient emptyTitle={pendingOnly ? 'Нет ожидающих уведомлений' : 'Пока нет заявок'} emptyText="Сохранённые заявки появятся здесь." />
    {data.nextCursor ? <p><Link className={inboxStyles.link} href={`/admin/wholesale/requests?before=${data.nextCursor}${pendingOnly ? '&pending=1' : ''}`}>Следующие 25 заявок</Link></p> : null}
  </section></main>;
}
