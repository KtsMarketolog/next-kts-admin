import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import sanitizeHtml from 'sanitize-html';

import { requireAdmin } from '@/shared/lib/adminAuth';

const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_SVG_FILE_SIZE = 2 * 1024 * 1024;
const MAX_PRICE_GROUP_SVG_WIDTH = 900;
const MAX_PRICE_GROUP_SVG_HEIGHT = 600;
const SVG_DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i;

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
  'mask',
  'pattern',
  'use',
  'image',
  'symbol',
  'clipPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'title',
  'desc',
];

const SVG_ALLOWED_ATTRIBUTES: sanitizeHtml.AllowedAttribute[] = [
  'xmlns',
  'xmlns:xlink',
  'version',
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
  'clip-path',
  'mask',
  'filter',
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
  'patternContentUnits',
  'patternUnits',
  'preserveAspectRatio',
  'href',
  'xlink:href',
];

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const formData = await request.formData();
  const file = formData.get('file');
  const rawKind = formData.get('kind');
  const kind = rawKind === 'brandLogo' || rawKind === 'priceGroup' || rawKind === 'categoryIcon' ? rawKind : 'image';

  if (!(file instanceof File)) {
    return Response.json({ error: 'File is required' }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return Response.json({ error: 'File is too large' }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const detectedType = detectImageType(bytes);

  if (file.type === 'image/svg+xml' || detectedType === 'svg') {
    if (kind !== 'brandLogo' && kind !== 'priceGroup' && kind !== 'categoryIcon') {
      return Response.json({ error: 'SVG is allowed only for brand logos, price groups and category icons' }, { status: 400 });
    }

    if (detectedType !== 'svg') {
      return Response.json({ error: 'Некорректный SVG файл' }, { status: 400 });
    }

    if (file.size > MAX_SVG_FILE_SIZE) {
      return Response.json({ error: 'SVG слишком большой. Максимальный размер файла: 2 МБ' }, { status: 400 });
    }

    try {
      const clean = sanitizeSvg(bytes);
      return saveUpload(kind === 'priceGroup' ? normalizePriceGroupSvgSize(clean) : clean, 'svg');
    } catch {
      return Response.json({ error: 'Некорректный SVG файл' }, { status: 400 });
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
  validateSvgReferences(source);

  const clean = sanitizeHtml(source, {
    allowedTags: SVG_ALLOWED_TAGS,
    allowedAttributes: {
      '*': SVG_ALLOWED_ATTRIBUTES,
    },
    allowedSchemes: [],
    allowedSchemesByTag: {
      image: ['data'],
    },
    allowedSchemesAppliedToAttributes: ['href', 'xlink:href'],
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

function validateSvgReferences(source: string) {
  const hrefPattern = /\s(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi;

  for (const match of source.matchAll(hrefPattern)) {
    const value = (match[2] ?? '').trim();
    if (!value || value.startsWith('#')) continue;

    if (value.startsWith('data:') && SVG_DATA_IMAGE_PATTERN.test(value)) {
      continue;
    }

    throw new Error('Unsupported SVG reference');
  }
}

function normalizePriceGroupSvgSize(bytes: Buffer) {
  const source = bytes.toString('utf8');
  const svgTag = source.match(/<svg\b[^>]*>/i)?.[0];
  if (!svgTag) {
    throw new Error('Invalid SVG file');
  }

  const size = parseSvgSize(svgTag);
  const sourceWidth = size.width ?? MAX_PRICE_GROUP_SVG_WIDTH;
  const sourceHeight = size.height ?? MAX_PRICE_GROUP_SVG_HEIGHT;
  const scale = Math.min(1, MAX_PRICE_GROUP_SVG_WIDTH / sourceWidth, MAX_PRICE_GROUP_SVG_HEIGHT / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  let nextSvgTag = setSvgAttribute(svgTag, 'width', `${width}px`);
  nextSvgTag = setSvgAttribute(nextSvgTag, 'height', `${height}px`);

  if (!getSvgAttribute(nextSvgTag, 'viewBox')) {
    nextSvgTag = setSvgAttribute(nextSvgTag, 'viewBox', `0 0 ${formatSvgNumber(sourceWidth)} ${formatSvgNumber(sourceHeight)}`);
  }

  return Buffer.from(source.replace(svgTag, nextSvgTag), 'utf8');
}

function parseSvgSize(svgTag: string) {
  const viewBox = parseViewBox(getSvgAttribute(svgTag, 'viewBox'));
  return {
    width: parseSvgLength(getSvgAttribute(svgTag, 'width')) ?? viewBox?.width,
    height: parseSvgLength(getSvgAttribute(svgTag, 'height')) ?? viewBox?.height,
  };
}

function getSvgAttribute(svgTag: string, name: string) {
  const match = svgTag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match?.[1] ?? null;
}

function setSvgAttribute(svgTag: string, name: string, value: string) {
  const attributePattern = new RegExp(`\\s${name}\\s*=\\s*(["'])[^"']*\\1`, 'i');
  if (attributePattern.test(svgTag)) {
    return svgTag.replace(attributePattern, ` ${name}="${value}"`);
  }

  return svgTag.replace(/<svg\b/i, `<svg ${name}="${value}"`);
}

function parseSvgLength(value: string | null) {
  if (!value) return null;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)(?:px)?$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseViewBox(value: string | null) {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [, , width, height] = parts;
  return width > 0 && height > 0 ? { width, height } : null;
}

function formatSvgNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
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

  const head = bytes.subarray(0, Math.min(bytes.length, 2048)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (head.includes('<svg')) {
    return 'svg';
  }

  return null;
}
