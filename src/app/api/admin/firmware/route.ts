import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireAdminSession } from '@/shared/lib/adminAuth';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { FirmwareError, MAX_FIRMWARE_BODY_BYTES, FIRMWARE_FILES, type FirmwareOverview } from '@/shared/lib/firmwareContract';
import { getFirmwareOverview, publishFirmwarePair, rollbackFirmwarePair } from '@/shared/lib/firmwareStorage';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

export const runtime = 'nodejs';

declare global {
  var __ktsFirmwareUploadInFlight: boolean | undefined;
}

function privateResponse(response: Response) {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

function failure(error: unknown) {
  if (error instanceof FirmwareError) {
    return privateResponse(Response.json({ error: error.message, code: error.code }, { status: error.status }));
  }
  console.error('firmware_operation_failed');
  return privateResponse(Response.json({ error: 'Не удалось выполнить операцию с прошивкой', code: 'INTERNAL_ERROR' }, { status: 500 }));
}

// Count actual streamed bytes before formData() buffers/parses the upload.
// Content-Length is only an early check, never the authoritative limit.
async function readBody(request: Request, limit: number) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new FirmwareError('REQUEST_TOO_LARGE', 413, 'Превышен допустимый размер запроса');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new FirmwareError('REQUEST_TOO_LARGE', 413, 'Превышен допустимый размер запроса');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof FirmwareError) throw error;
      throw new FirmwareError('INVALID_BODY', 400, 'Не удалось прочитать запрос');
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

function text(value: unknown, label: string, maxLength = 160) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength) {
    throw new FirmwareError('INVALID_REQUEST', 400, `Некорректное поле: ${label}`);
  }
  return value;
}

function checksum(value: unknown) {
  const result = text(value, 'SHA256', 64);
  if (!/^[a-f\d]{64}$/i.test(result)) throw new FirmwareError('INVALID_REQUEST', 400, 'Некорректный SHA256');
  return result.toLowerCase();
}

export async function GET() {
  const { denied } = await requireAdminSession();
  if (denied) return privateResponse(denied);
  try { return privateResponse(Response.json(await getFirmwareOverview())); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const { denied, session } = await requireAdminSession();
  if (denied) return privateResponse(denied);
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return privateResponse(forbiddenOrigin);
  const limited = await enforceAdminActionRateLimit(session, 'firmware_update', 20, 30 * 60 * 1000);
  if (limited) return privateResponse(limited);
  // Bound aggregate buffering on this worker; the storage lock independently
  // serializes commits across workers. No await between checking and claiming.
  if (globalThis.__ktsFirmwareUploadInFlight) {
    return failure(new FirmwareError('BUSY', 409, 'Операция с прошивкой уже выполняется. Повторите позже'));
  }
  globalThis.__ktsFirmwareUploadInFlight = true;

  let overview: FirmwareOverview;
  let action: 'publish' | 'rollback';
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (/^multipart\/form-data(?:;|$)/i.test(contentType)) {
      const bytes = await readBody(request, MAX_FIRMWARE_BODY_BYTES);
      let form: FormData;
      try { form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData(); }
      catch { throw new FirmwareError('INVALID_BODY', 400, 'Некорректная форма загрузки'); }
      const fields = ['action', 'c23', 'ver', 'expectedRevision', 'c23Sha256', 'verSha256'];
      if ([...form.keys()].some((key) => !fields.includes(key)) || fields.some((key) => form.getAll(key).length !== 1)) {
        throw new FirmwareError('INVALID_REQUEST', 400, 'Загрузите одну пару файлов .c23 и .ver');
      }
      if (form.get('action') !== 'publish') throw new FirmwareError('INVALID_REQUEST', 400, 'Неизвестное действие');
      const c23 = form.get('c23'), ver = form.get('ver');
      for (const [kind, file] of [['c23', c23], ['ver', ver]] as const) {
        if (!(file instanceof File) || !file.name.toLowerCase().endsWith(`.${kind}`) || file.size <= 0) {
          throw new FirmwareError('INVALID_FILE', 400, `Выберите непустой файл .${kind}`);
        }
        if (file.size > FIRMWARE_FILES[kind].maxBytes) {
          throw new FirmwareError('FILE_TOO_LARGE', 413, kind === 'c23' ? 'Файл .c23 превышает 25 МиБ' : 'Файл .ver превышает 4 КиБ');
        }
      }
      action = 'publish';
      overview = await publishFirmwarePair({
        c23: c23 as File, ver: ver as File,
        expectedRevision: text(form.get('expectedRevision'), 'ревизия'),
        c23Sha256: checksum(form.get('c23Sha256')), verSha256: checksum(form.get('verSha256')),
      });
    } else if (/^application\/json(?:;|$)/i.test(contentType)) {
      const bytes = await readBody(request, 4096);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new FirmwareError('INVALID_BODY', 400, 'Некорректный запрос отката'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FirmwareError('INVALID_REQUEST', 400, 'Некорректный запрос отката');
      const data = body as Record<string, unknown>;
      if (data.action !== 'rollback' || Object.keys(data).some((key) => !['action', 'expectedRevision', 'previousId'].includes(key))) {
        throw new FirmwareError('INVALID_REQUEST', 400, 'Неизвестное действие или поле запроса');
      }
      action = 'rollback';
      overview = await rollbackFirmwarePair({ expectedRevision: text(data.expectedRevision, 'ревизия'), previousId: text(data.previousId, 'предыдущая версия') });
    } else {
      throw new FirmwareError('UNSUPPORTED_CONTENT_TYPE', 415, 'Используйте форму загрузки пары или запрос отката');
    }
  } catch (error) { return failure(error); }
  finally { globalThis.__ktsFirmwareUploadInFlight = false; }

  // Storage has already committed. Audit unavailability must not invite a
  // duplicate publication by changing this success into an error response.
  try {
    await recordSecurityEvent({
      eventType: 'firmware_file_updated', actorType: 'admin', adminUserId: session.adminUserId,
      sessionId: session.sessionId, entityType: 'firmware', entityId: overview.current?.id,
      ip: getClientIp(request), userAgent: request.headers.get('user-agent'), referer: request.headers.get('referer'),
      metadata: { action, revision: overview.revision, previousId: overview.previous?.id ?? null,
        c23Sha256: overview.current?.files.c23.sha256, verSha256: overview.current?.files.ver.sha256 },
    });
  } catch { console.error('firmware_audit_failed_after_commit'); }
  return privateResponse(Response.json(overview));
}
