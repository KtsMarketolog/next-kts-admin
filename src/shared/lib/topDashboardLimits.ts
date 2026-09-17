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

// Unchanged per-block disk safety cap. Protected current/previous data pairs for
// retained HTMLs must fit together; uploads reject rather than evict rollback data.
export const TOP_DASHBOARD_DATA_STORAGE_LIMIT_BYTES = TOP_DASHBOARD_DATA_STORED_MAX_BYTES * 3;

export const TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES = 512 * 1024;

// Discovery is an inventory of available HTML fields, not the number selected
// for one snapshot. Keep the inventory separate from the 32-target envelope cap.
export const TOP_DASHBOARD_UPLOAD_MAX_DISCOVERED_TARGETS = 256;
