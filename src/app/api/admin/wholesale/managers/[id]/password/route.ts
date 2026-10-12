import { requireWholesaleAdminSession } from '@/shared/lib/adminAuth';
import { employeePasswordResponse, uncachedPasswordResponse } from '@/shared/lib/employeePasswordResponse';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return uncachedPasswordResponse(denied);
  const { id } = await context.params;
  return employeePasswordResponse(request, `manager:${id}`, session);
}
