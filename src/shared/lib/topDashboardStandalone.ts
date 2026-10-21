import sanitizeHtml from 'sanitize-html';
import { isProfitabilityHtmlCandidate } from './dashboardProfitabilityHtml';

/** A mode declaration, not an author-version fingerprint or an authorization grant. */
export const TOP_DASHBOARD_STANDALONE_MARKER = '<meta name="kts-dashboard-mode" content="standalone-v1">';
const MARKER_SCAN_MAX_CHARACTERS = 64 * 1024;

export function hasStandaloneTopDashboardMarker(html: string): boolean {
  let found = false;
  // Our upload marker is always at the start of <head>. Bound this metadata
  // inspection independently of embedded libraries and business data. Parsing
  // actual tags avoids recognizing quoted examples inside scripts/comments.
  sanitizeHtml(html.slice(0, MARKER_SCAN_MAX_CHARACTERS), {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ['script', 'style', 'textarea', 'title', 'noscript', 'template'],
    transformTags: {
      meta(tagName, attributes) {
        if (attributes.name?.toLowerCase() === 'kts-dashboard-mode'
          && attributes.content === 'standalone-v1') found = true;
        return { tagName, attribs: attributes };
      },
    },
  });
  return found;
}

/** Private invoice inputs must never enter the generic shared snapshot bridge. */
export function isStandaloneTopDashboardHtml(html: string): boolean {
  return hasStandaloneTopDashboardMarker(html) || isProfitabilityHtmlCandidate(html);
}

/** Keep every author byte intact; add only the persisted integration-mode marker. */
export function addStandaloneTopDashboardMarker(html: string): string {
  if (hasStandaloneTopDashboardMarker(html)) return html;
  const start = html.slice(0, MARKER_SCAN_MAX_CHARACTERS);
  // Ignore comments before the structural head (e.g. an author's code example).
  // Spaces preserve offsets into the original document without rewriting it.
  const structural = start
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (value) => ' '.repeat(value.length))
    .replace(/<(script|style|textarea|title|noscript|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
      (value) => ' '.repeat(value.length));
  const head = /<head(?:\s[^>]*)?>/i.exec(structural);
  const root = /<html(?:\s[^>]*)?>/i.exec(structural);
  const doctype = /<!doctype\s+html[^>]*>/i.exec(structural);
  const position = head ? head.index + head[0].length
    : root ? root.index + root[0].length
      : doctype ? doctype.index + doctype[0].length : 0;
  const insertion = head ? TOP_DASHBOARD_STANDALONE_MARKER
    : `<head>${TOP_DASHBOARD_STANDALONE_MARKER}</head>`;
  return `${html.slice(0, position)}${insertion}${html.slice(position)}`;
}
