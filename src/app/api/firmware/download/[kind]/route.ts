import { firmwareDownloadResponse } from '@/shared/lib/firmwareDownload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function download(request: Request, context: { params: Promise<{ kind: string }> }) {
  const { kind } = await context.params;
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' };
  if (kind !== 'c23' && kind !== 'ver') return new Response(null, { status: 404, headers });
  try { return await firmwareDownloadResponse(request, kind); }
  catch {
    // Do not expose internal paths or serve a silently different legacy release.
    return new Response(null, { status: 503, headers });
  }
}

export const GET = download;
export const HEAD = download;
