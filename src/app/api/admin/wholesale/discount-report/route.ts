import { requireWholesaleAdminSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { getWholesaleDiscountReportRows } from '@/shared/lib/db';
import { renderWholesaleDiscountReport } from '@/shared/lib/wholesaleDiscountReportExport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return denied;

  const limited = await enforceAdminActionRateLimit(session, 'wholesale_discount_report_download', 80);
  if (limited) return limited;

  const rows = await getWholesaleDiscountReportRows();
  const file = renderWholesaleDiscountReport(rows);

  return new Response(new Uint8Array(file.content), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Cache-Control': 'private, no-store',
    },
  });
}
