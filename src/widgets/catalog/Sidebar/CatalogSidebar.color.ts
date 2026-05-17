const ICON_COLOR_FALLBACKS: Record<string, string> = {
  kompressory: '#E42B34',
  ventilyatory: '#08265c',
  'ventilyatory-i-mikrodvigateli': '#08265c',
  'teploobmennoe-oborudovanie': '#2f0a58',
  'sosudy-davleniya': '#2ba0e3',
  'elektronnye-komponenty': '#fb4f75',
  'lineynye-komponenty': '#1fa355',
  'linejnye-komponenty': '#1fa355',
  'nagrevatelnye-elementy': '#034831',
  'truby-i-fitingi': '#ff601f',
};

function toHex(value: number) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

function getSaturation(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function loadIconImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load category icon'));
    image.src = src;
  });
}

function extractIconBackgroundColor(image: HTMLImageElement) {
  const canvas = document.createElement('canvas');
  const size = 48;
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  context.clearRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);

  const pixels = context.getImageData(0, 0, size, size).data;
  const buckets = new Map<string, { r: number; g: number; b: number; weight: number }>();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 90) continue;

    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);

    if (max > 245 && min > 235) continue;
    if (getSaturation(r, g, b) < 0.08 && max > 160) continue;

    const pixel = index / 4;
    const x = pixel % size;
    const y = Math.floor(pixel / size);
    const isEdge = x < 7 || y < 7 || x >= size - 7 || y >= size - 7;
    const weight = isEdge ? 4 : 1;
    const key = `${Math.round(r / 16)},${Math.round(g / 16)},${Math.round(b / 16)}`;
    const current = buckets.get(key) ?? { r: 0, g: 0, b: 0, weight: 0 };

    current.r += r * weight;
    current.g += g * weight;
    current.b += b * weight;
    current.weight += weight;
    buckets.set(key, current);
  }

  const dominant = Array.from(buckets.values()).sort((a, b) => b.weight - a.weight)[0];
  if (!dominant) return null;

  const r = dominant.r / dominant.weight;
  const g = dominant.g / dominant.weight;
  const b = dominant.b / dominant.weight;

  if (getSaturation(r, g, b) < 0.08) return null;

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export async function readIconBackgroundColor(icon: string, slug: string) {
  const image = await loadIconImage(icon);
  return extractIconBackgroundColor(image) ?? ICON_COLOR_FALLBACKS[slug] ?? null;
}

export function fallbackIconLineColor(slug: string) {
  return ICON_COLOR_FALLBACKS[slug] ?? null;
}
