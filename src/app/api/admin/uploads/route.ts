import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import sanitizeHtml from 'sanitize-html';

import { requireAdmin } from '@/shared/lib/adminAuth';

const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_SVG_FILE_SIZE = 512 * 1024;

const RASTER_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
]);

const SVG_ALLOWED_TAGS = [
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'clipPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'title',
  'desc',
];

const SVG_ALLOWED_ATTRIBUTES: sanitizeHtml.AllowedAttribute[] = [
  'xmlns',
  'viewBox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'fill',
  'fill-rule',
  'clip-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'id',
  'class',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
];

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const formData = await request.formData();
  const file = formData.get('file');
  const rawKind = formData.get('kind');
  const kind = rawKind === 'brandLogo' || rawKind === 'priceGroup' ? rawKind : 'image';

  if (!(file instanceof File)) {
    return Response.json({ error: 'File is required' }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return Response.json({ error: 'File is too large' }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const detectedType = detectImageType(bytes);

  if (file.type === 'image/svg+xml' || detectedType === 'svg') {
    if (kind !== 'brandLogo' && kind !== 'priceGroup') {
      return Response.json({ error: 'SVG is allowed only for brand logos and price groups' }, { status: 400 });
    }

    if (file.size > MAX_SVG_FILE_SIZE || detectedType !== 'svg') {
      return Response.json({ error: 'Invalid SVG file' }, { status: 400 });
    }

    try {
      return saveUpload(sanitizeSvg(bytes), 'svg');
    } catch {
      return Response.json({ error: 'Invalid SVG file' }, { status: 400 });
    }
  }

  const ext = RASTER_TYPES.get(file.type);
  if (!ext || detectedType !== ext) {
    return Response.json({ error: 'Unsupported image type' }, { status: 400 });
  }

  return saveUpload(bytes, ext);
}

async function saveUpload(bytes: Buffer, ext: string) {
  const uploadDir = path.join(getUploadRoot(), 'hero');
  await mkdir(uploadDir, { recursive: true });

  const filename = `${Date.now()}-${randomUUID()}.${ext}`;
  await writeFile(path.join(uploadDir, filename), bytes);

  return Response.json({ url: `/uploads/hero/${filename}` });
}

function getUploadRoot() {
  const configuredPath = process.env.UPLOAD_DIR?.trim();
  if (configuredPath) return configuredPath;

  if (process.env.NODE_ENV === 'production' && process.platform !== 'win32') {
    return '/var/www/kts-uploads';
  }

  return path.join(process.cwd(), 'public', 'uploads');
}

function sanitizeSvg(bytes: Buffer) {
  const source = bytes.toString('utf8');
  const clean = sanitizeHtml(source, {
    allowedTags: SVG_ALLOWED_TAGS,
    allowedAttributes: {
      '*': SVG_ALLOWED_ATTRIBUTES,
    },
    allowedSchemes: [],
    parser: {
      lowerCaseAttributeNames: false,
      lowerCaseTags: false,
    },
  });

  if (!clean.includes('<svg')) {
    throw new Error('Invalid SVG file');
  }

  return Buffer.from(clean, 'utf8');
}

function detectImageType(bytes: Buffer) {
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }

  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }

  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }

  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }

  const head = bytes.subarray(0, Math.min(bytes.length, 512)).toString('utf8').trimStart();
  if ((head.startsWith('<svg') || head.startsWith('<?xml')) && head.includes('<svg')) {
    return 'svg';
  }

  return null;
}
