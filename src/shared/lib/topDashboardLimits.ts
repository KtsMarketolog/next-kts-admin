// Large dashboard uploads use the raw stream-v1 endpoint and are written to
// protected file storage without buffering the whole request in application
// memory. Keep the legacy multipart fallback below this limit.
export const TOP_DASHBOARD_DATA_MAX_MEGABYTES = 500;
export const TOP_DASHBOARD_DATA_MAX_BYTES = TOP_DASHBOARD_DATA_MAX_MEGABYTES * 1024 * 1024;

// The universal KTSMF envelope has bounded metadata in addition to the raw
// files. Its documented cardinality and text limits fit inside this allowance.
export const TOP_DASHBOARD_DATA_ENVELOPE_OVERHEAD_BYTES = 512 * 1024;
export const TOP_DASHBOARD_DATA_STORED_MAX_BYTES =
  TOP_DASHBOARD_DATA_MAX_BYTES + TOP_DASHBOARD_DATA_ENVELOPE_OVERHEAD_BYTES;

export const TOP_DASHBOARD_DATA_MULTIPART_MAX_MEGABYTES = 100;
export const TOP_DASHBOARD_DATA_MULTIPART_MAX_BYTES =
  TOP_DASHBOARD_DATA_MULTIPART_MAX_MEGABYTES * 1024 * 1024;

export const TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_MEGABYTES = 2 * 1024;
export const TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_BYTES =
  TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_MEGABYTES * 1024 * 1024;
export const TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_LABEL = '2 ГБ';

// Technical resource budgets, not a business schema. Unknown sections/fields
// are allowed. Measured snapshots use depth <= 8 and strings below 3 KiB;
// leave ample headroom for future exports and large tables.
export const TOP_DASHBOARD_JSON_RESOURCE_LIMITS = {
  maxStringBytes: 8 * 1024 * 1024,
  maxKeyBytes: 64 * 1024,
  maxNumberBytes: 1024,
  maxDepth: 128,
  maxTokens: 1_000_000_000,
  // Active scanner/parser time only: slow network uploads do not consume it.
  maxProcessingMs: 120_000,
} as const;

// Unchanged per-block disk safety cap. Protected current/previous data pairs for
// retained HTMLs must fit together; uploads reject rather than evict rollback data.
export const TOP_DASHBOARD_DATA_STORAGE_LIMIT_BYTES = TOP_DASHBOARD_DATA_STORED_MAX_BYTES * 3;

export const TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES = 512 * 1024;

// Discovery is an inventory of available HTML fields, not the number selected
// for one snapshot. Keep the inventory separate from the 32-target envelope cap.
export const TOP_DASHBOARD_UPLOAD_MAX_DISCOVERED_TARGETS = 256;
// TOP HTML may include its own PDF/XLSX libraries and reference data.
// Personal manager dashboards and the per-block storage quota are unchanged.
export const TOP_DASHBOARD_HTML_MAX_MEGABYTES = 20;
export const TOP_DASHBOARD_HTML_MAX_BYTES = TOP_DASHBOARD_HTML_MAX_MEGABYTES * 1024 * 1024;
