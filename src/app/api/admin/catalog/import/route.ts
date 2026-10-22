import { parseCatalogExcel } from '@/entities/catalog/api/catalogExcel';
import { replaceCatalogFromRows } from '@/entities/catalog/api/catalogAdmin';
import { CatalogImportDuplicateError } from '@/entities/catalog/api/catalogImportValidation';
import { CatalogExistingArticleConflictError } from '@/entities/catalog/api/catalogAdmin/importMatching';
import { revalidatePublicCatalog } from '@/entities/catalog/api/catalogRevalidation';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireAdminSession } from '@/shared/lib/adminAuth';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';
import { runPostCommitTasks } from '@/shared/lib/postCommitTasks';
import { TransactionCommitUnknownError } from '@/shared/lib/db/transactionOutcome';

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

function badRequest(error: string, status = 400) {
  return Response.json({ saved: false, error }, { status });
}

export async function POST(request: Request) {
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;
  const limited = await enforceAdminActionRateLimit(session, 'catalog_import', 10, 30 * 60 * 1000);
  if (limited) return limited;

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) return badRequest('Excel-файл обязателен');
    if (file.size <= 0) return badRequest('Файл пустой');
    if (file.size > MAX_IMPORT_BYTES) return badRequest('Файл слишком большой');
    if (!/\.(xlsx|xls)$/i.test(file.name)) return badRequest('Загрузите файл .xlsx или .xls');

    const buffer = Buffer.from(await file.arrayBuffer());
    const rows = parseCatalogExcel(buffer);
    const result = await replaceCatalogFromRows(rows);
    const warnings = [...result.warnings, ...await runPostCommitTasks([{
      code: 'CATALOG_IMPORT_CACHE_UNAVAILABLE',
      message: 'Каталог сохранён, но обновление кеша сайта не завершено. Требуется проверить кеш; повторно загружать Excel не нужно.',
      run: () => revalidatePublicCatalog(),
    }, {
      code: 'CATALOG_IMPORT_AUDIT_UNAVAILABLE',
      message: 'Каталог сохранён, но запись в журнал безопасности не добавлена. Требуется повторить журналирование, а не загрузку Excel.',
      run: () => recordSecurityEvent({
        eventType: 'catalog_imported',
        actorType: 'admin',
        adminUserId: session.adminUserId,
        sessionId: session.sessionId,
        entityType: 'catalog',
        entityId: 'excel',
        ip: getClientIp(request),
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
        metadata: {
          fileName: file.name,
          fileSize: file.size,
          importedProducts: result.importedProducts,
          categories: result.categories,
          subcategories: result.subcategories,
          brands: result.brands,
        },
      }, { required: true }),
    }])];

    return Response.json({ saved: true, result, warnings }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof CatalogImportDuplicateError || error instanceof CatalogExistingArticleConflictError) {
      // Both errors are raised before the first catalog write. Keep the structured
      // diagnostics separate from generic/unknown save errors in the interface.
      return Response.json({ saved: false, error: error.message, code: error.code, duplicates: error.duplicates,
        duplicateCount: error.duplicateCount, truncated: error.truncated }, {
        status: error instanceof CatalogImportDuplicateError ? 400 : 409,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ saved: null, code: error.code, error: error.message }, {
        status: 503, headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    return badRequest(error instanceof Error ? error.message : 'Не удалось загрузить каталог');
  }
}
