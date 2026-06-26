import { mkdir, stat, writeFile } from 'fs/promises';
import path from 'path';

import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireAdminSession } from '@/shared/lib/adminAuth';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

const MAX_FIRMWARE_BYTES = 25 * 1024 * 1024;
const FIRMWARE_PUBLIC_ORIGIN = 'http://kts-impex.ru';
const FIRMWARE_PUBLIC_BASE = '/klimatika/prog/firmware/update';

const FIRMWARE_FILES = [
  {
    id: 'hse_gen_1_c23',
    fileName: 'hse_gen_1.c23',
    relativeDir: 'hse/gen_1',
    accept: '.c23',
  },
  {
    id: 'hse_gen_1_ver',
    fileName: 'hse_gen_1.ver',
    relativeDir: 'hse/gen_1',
    accept: '.ver',
  },
] as const;

function badRequest(error: string, status = 400) {
  return Response.json({ error }, { status });
}

function firmwareRoot() {
  return path.join(process.cwd(), 'public', 'klimatika', 'prog', 'firmware', 'update');
}

function publicUrl(file: (typeof FIRMWARE_FILES)[number]) {
  return `${FIRMWARE_PUBLIC_ORIGIN}${FIRMWARE_PUBLIC_BASE}/${file.relativeDir}/${file.fileName}`;
}

function targetPath(file: (typeof FIRMWARE_FILES)[number]) {
  return path.join(firmwareRoot(), file.relativeDir, file.fileName);
}

async function fileInfo(file: (typeof FIRMWARE_FILES)[number]) {
  try {
    const info = await stat(targetPath(file));
    return {
      id: file.id,
      fileName: file.fileName,
      url: publicUrl(file),
      accept: file.accept,
      size: info.size,
      updatedAt: info.mtime.toISOString(),
      exists: true,
    };
  } catch {
    return {
      id: file.id,
      fileName: file.fileName,
      url: publicUrl(file),
      accept: file.accept,
      size: null,
      updatedAt: null,
      exists: false,
    };
  }
}

function findFirmwareTarget(value: FormDataEntryValue | null) {
  return FIRMWARE_FILES.find((item) => item.id === value) ?? null;
}

export async function GET() {
  const { denied } = await requireAdminSession();
  if (denied) return denied;

  const files = await Promise.all(FIRMWARE_FILES.map(fileInfo));
  return Response.json({ files });
}

export async function POST(request: Request) {
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;
  const limited = await enforceAdminActionRateLimit(session, 'firmware_update', 20, 30 * 60 * 1000);
  if (limited) return limited;

  try {
    const formData = await request.formData();
    const target = findFirmwareTarget(formData.get('target'));
    const file = formData.get('file');

    if (!target) return badRequest('Неизвестный файл прошивки');
    if (!(file instanceof File)) return badRequest('Файл обязателен');
    if (file.size <= 0) return badRequest('Файл пустой');
    if (file.size > MAX_FIRMWARE_BYTES) return badRequest('Файл слишком большой');
    if (!file.name.toLowerCase().endsWith(target.accept)) return badRequest(`Загрузите файл ${target.accept}`);

    const destination = targetPath(target);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(await file.arrayBuffer()));

    const info = await fileInfo(target);

    await recordSecurityEvent({
      eventType: 'firmware_file_updated',
      actorType: 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'firmware',
      entityId: target.fileName,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        sourceFileName: file.name,
        fileSize: file.size,
        targetUrl: publicUrl(target),
      },
    });

    return Response.json({ file: info });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'Не удалось заменить файл прошивки');
  }
}
