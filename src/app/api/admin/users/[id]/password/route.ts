import { requireAdminSession } from '@/shared/lib/adminAuth';
import { employeePasswordResponse, uncachedPasswordResponse } from '@/shared/lib/employeePasswordResponse';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { denied, session } = await requireAdminSession();
  if (denied) return uncachedPasswordResponse(denied);
  const { id } = await context.params;
  return employeePasswordResponse(request, id, session);
}
