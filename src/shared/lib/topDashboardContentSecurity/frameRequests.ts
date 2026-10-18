// Validate the trusted same-origin shell, never an uploaded HTML document.
export function isTopDashboardBlockFrameRequest(
  request: Request,
  blockId: number,
  versionId: number,
) {
  return isExpectedTopDashboardFrameRequest(
    request,
    `/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/frame`,
  );
}

export function getTopDashboardBlockDataFrameVersionId(
  request: Request,
  blockId: number,
): number | null {
  if (request.method !== 'GET') return null;
  return getTopDashboardBlockDataRequestFrameVersionId(request, blockId);
}

export function isTopDashboardBlockDataMutationFrameRequest(
  request: Request,
  blockId: number,
  htmlVersionId: number,
) {
  if (request.method !== 'PUT') return false;
  return getTopDashboardBlockDataRequestFrameVersionId(request, blockId) === htmlVersionId;
}

function getTopDashboardBlockDataRequestFrameVersionId(
  request: Request,
  blockId: number,
): number | null {
  if (request.headers.get('sec-fetch-dest') !== 'empty') return null;
  if (request.headers.get('sec-fetch-mode') !== 'cors') return null;
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return null;

  const referer = request.headers.get('referer');
  if (!referer) return null;

  try {
    const refererUrl = new URL(referer);
    const escapedBlockId = String(blockId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expectedPath = new RegExp(
      `^/api/admin/top-dashboard/blocks/${escapedBlockId}/versions/([1-9]\\d*)/frame$`,
    );
    const match = expectedPath.exec(refererUrl.pathname);
    if (!match) return null;
    const versionId = Number(match[1]);
    return Number.isSafeInteger(versionId) ? versionId : null;
  } catch {
    return null;
  }
}

export function isTopDashboardBlockDataFrameRequest(request: Request, blockId: number) {
  return getTopDashboardBlockDataFrameVersionId(request, blockId) !== null;
}

function isExpectedTopDashboardFrameRequest(request: Request, expectedFramePath: string) {
  if (request.headers.get('sec-fetch-dest') !== 'iframe') return false;
  if (request.headers.get('sec-fetch-mode') !== 'navigate') return false;
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return false;

  const referer = request.headers.get('referer');
  if (!referer) return false;

  try {
    const refererUrl = new URL(referer);
    // In production Next.js receives an internal 127.0.0.1 request URL from the
    // reverse proxy, while the browser Referer contains the public origin. The
    // forbidden Sec-Fetch-* headers above prove a same-origin iframe navigation;
    // only the exact trusted shell path needs to be matched here.
    return refererUrl.pathname === expectedFramePath;
  } catch {
    return false;
  }
}
