// Next applies configured headers before Route Handlers and preserves an
// already-set CSP. Only these two HTML handlers must supply their own policy.
// Keep the end anchor: data, downloads, nested paths and every other API retain
// the site's global CSP. IDs use the same canonical positive-integer shape as
// the report URLs; an optional trailing slash is handled before normalization.
export const GLOBAL_CSP_SOURCE =
  '/:path((?!api/admin/top-dashboard/blocks/[1-9][0-9]*/versions/[1-9][0-9]*/(?:frame|content)/?$).*)';
