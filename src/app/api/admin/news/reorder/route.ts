import { handleAdminContentReorder } from '@/shared/lib/adminContentOrderRoute';

export async function PUT(request: Request) {
  return handleAdminContentReorder(request, 'news');
}
