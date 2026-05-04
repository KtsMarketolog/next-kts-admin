const CMS = (process.env.NEXT_PUBLIC_CMS_URL ?? '').replace(/\/+$/, '');

export function mediaUrl(path?: string | null): string {
  if (!path) return '';
  if (path.startsWith('/uploads/') || path.startsWith('/img/')) return path;
  if (/^https?:\/\//i.test(path)) return path.replace(/^http:\/\//i, 'https://');
  if (!CMS) return path.startsWith('/') ? path : `/${path}`;
  return `${CMS}${path.startsWith('/') ? '' : '/'}${path}`;
}
