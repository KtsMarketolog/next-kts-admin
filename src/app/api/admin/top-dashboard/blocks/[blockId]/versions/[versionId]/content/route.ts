import { canReadTopDashboardBlock } from '@/shared/lib/dashboardAccess';
import { injectSalesOfficeView } from '@/shared/lib/dashboardOfficeView';
import { prepareInteractiveDashboardHtml } from '@/shared/lib/topDashboardContentSecurity/preparedHtml';
import { injectProfitabilityAuditAdapter, supportsDashboardInvoiceAudit } from '@/shared/lib/dashboardProfitabilityHtml';
import { isActiveTopDashboardHtmlVersion } from '@/shared/lib/db/topDashboardBlocksRepo';
import {
  isTopDashboardManagementSession,
  requireTopDashboardSession,
} from '@/shared/lib/adminAuth';
import {
  getPublishedTopDashboardBlockVersionContent,
  getTopDashboardBlockVersionContent,
  TopDashboardBlockNotFoundError,
} from '@/shared/lib/db';
import {
  buildTopDashboardContentSecurityPolicy,
  injectTopDashboardDataAdapter,
  isTopDashboardBlockFrameRequest,
  detectTopDashboardDataContract,
} from '@/shared/lib/topDashboardContentSecurity';

import { parsePositiveId } from '../../../../routeUtils';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ blockId: string; versionId: string }>;
};

export async function GET(request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardSession();
  if (denied) return denied;

  const { blockId: rawBlockId, versionId: rawVersionId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  const versionId = parsePositiveId(rawVersionId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });
  if (!canReadTopDashboardBlock(session, blockId)) {
    return Response.json({ error: 'Нет доступа к этому отчёту' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } });
  }
  if (!versionId) return Response.json({ error: 'Некорректная версия HTML' }, { status: 400 });
  if (!isTopDashboardBlockFrameRequest(request, blockId, versionId)) {
    return Response.json(
      { error: 'HTML доступен только в защищенном предпросмотре' },
      { status: 403 },
    );
  }

  try {
    const canManage = isTopDashboardManagementSession(session);
    let version = canManage
      ? await getTopDashboardBlockVersionContent(blockId, versionId)
      : await getPublishedTopDashboardBlockVersionContent(blockId, versionId);
    if (!version && !canManage) {
      const localVersion = await getTopDashboardBlockVersionContent(blockId, versionId);
      if (localVersion) {
        const profile = detectTopDashboardDataContract(localVersion.htmlContent).profile;
        if ((profile === 'profitability' || profile === 'standalone')
          && await isActiveTopDashboardHtmlVersion(blockId, versionId)) version = localVersion;
      }
    }
    if (!version) return Response.json({ error: 'Версия HTML не найдена' }, { status: 404 });

    const officeView = new URL(request.url).searchParams.get('view') === 'sales-office';
    const profile = detectTopDashboardDataContract(version.htmlContent).profile;
    const localReport = profile === 'profitability' || profile === 'standalone';
    const invoiceAudit = !officeView && localReport && supportsDashboardInvoiceAudit(version.htmlContent);
    const adapted = injectTopDashboardDataAdapter(version.htmlContent, {
      readOnly: officeView || !canManage,
      localInvoiceMode: localReport && !officeView,
    });
    const viewHtml = officeView ? injectSalesOfficeView(adapted) : invoiceAudit ? injectProfitabilityAuditAdapter(adapted) : adapted;
    // Compile author event templates for this response only. Stored versions,
    // profile fingerprints, snapshots and the original download stay untouched.
    const htmlContent = prepareInteractiveDashboardHtml(viewHtml);
    const bytes = Buffer.from(htmlContent, 'utf8');
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(bytes.length),
        'Content-Disposition': 'inline; filename="dashboard.html"',
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        'Content-Security-Policy': buildTopDashboardContentSecurityPolicy(htmlContent, { allowBlobModules: localReport && !officeView }),
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'X-DNS-Prefetch-Control': 'off',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=*',
      },
    });
  } catch (error) {
    if (error instanceof TopDashboardBlockNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error('Failed to read TOP dashboard block HTML', error);
    return Response.json({ error: 'Не удалось открыть HTML-файл' }, { status: 500 });
  }
}
