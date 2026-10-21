import { redirect } from 'next/navigation';
import { getAdminSession } from '@/shared/lib/adminAuth';
import { canAccessKnowledgeBase, canManageKnowledgeBase } from '@/shared/lib/knowledgeBase';
import { KnowledgeBase } from '@/features/admin/knowledge-base/KnowledgeBase';

export const dynamic = 'force-dynamic';

export default async function KnowledgeBasePage({ searchParams }: { searchParams: Promise<{ folder?: string }> }) {
  const session = await getAdminSession();
  if (!canAccessKnowledgeBase(session)) redirect('/login?mode=employee');
  const { folder } = await searchParams;
  const parentId = typeof folder === 'string' && /^[1-9]\d*$/.test(folder) && Number.isSafeInteger(Number(folder)) ? Number(folder) : null;
  return <KnowledgeBase initialCanManage={canManageKnowledgeBase(session)} initialParentId={parentId} />;
}
