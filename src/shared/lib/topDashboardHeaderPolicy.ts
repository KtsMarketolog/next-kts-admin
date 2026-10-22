// Next applies configured headers before Route Handlers and preserves an
// already-set CSP. Report HTML and authenticated knowledge-base file handlers
// must supply their own policy (including the stricter attachment policy).
// Keep the end anchor: nested paths and other APIs retain the site's global CSP.
// IDs use canonical positive integers; allow a trailing slash before Next's
// normalization. Common security headers still apply to every response.
export const GLOBAL_CSP_SOURCE =
  '/:path((?!(?:api/admin/top-dashboard/blocks/[1-9][0-9]*/versions/[1-9][0-9]*/(?:frame|content)|api/admin/knowledge-base/files/[1-9][0-9]*)/?$).*)';
