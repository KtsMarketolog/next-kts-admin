import { getStockImportLogs } from '@/entities/catalog/api/stockImport';
import { requireAdminSession } from '@/shared/lib/adminAuth';

export async function GET(request: Request) {
  const { denied } = await requireAdminSession();
  if (denied) return denied;

  const url = new URL(request.url);
  const logs = await getStockImportLogs(Number(url.searchParams.get('limit') ?? 20));
  return Response.json({ logs });
}
