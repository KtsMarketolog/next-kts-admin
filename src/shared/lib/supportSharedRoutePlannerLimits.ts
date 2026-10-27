/** Shared by the browser and server; applies only to the route-planner JSON report. */
export const SUPPORT_SHARED_JSON_MAX_BYTES = 500 * 1024 * 1024;
// Gzip can slightly expand incompressible input. Do not make the transport cap
// smaller than the supported source JSON; keep this independent of other uploads.
export const SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES = 501 * 1024 * 1024;
export const SUPPORT_SHARED_JSON_MAX_VERSIONS = 2;
// Current and previous JSON for both the current and previous HTML publication.
export const SUPPORT_SHARED_JSON_TOTAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export const SUPPORT_SHARED_JSON_MAX_MIB = SUPPORT_SHARED_JSON_MAX_BYTES / (1024 * 1024);
export const SUPPORT_SHARED_JSON_COMPRESSED_MAX_MIB = SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES / (1024 * 1024);
