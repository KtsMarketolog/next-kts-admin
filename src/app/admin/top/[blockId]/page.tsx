import { notFound, redirect } from 'next/navigation';

import { getAdminSession } from '@/shared/lib/adminAuth';

import AdminPanel from '../../AdminPanel';

export const dynamic = 'force-dynamic';

type AdminTopBlockPageProps = {
  params: Promise<{ blockId: string }>;
};

function parseBlockId(value: string) {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const blockId = Number(value);
  return Number.isSafeInteger(blockId) ? blockId : null;
}

export default async function AdminTopBlockPage({ params }: AdminTopBlockPageProps) {
  const { blockId: blockIdValue } = await params;
  const blockId = parseBlockId(blockIdValue);
  if (!blockId) notFound();

  const session = await getAdminSession();
  if (session && session.role !== 'admin' && session.role !== 'top') {
    redirect('/admin');
  }

  return (
    <AdminPanel
      initialArea="top"
      initialSession={session}
      initialTopDashboardBlockId={blockId}
    />
  );
}
