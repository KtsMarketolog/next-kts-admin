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

// Keep enough room for the active version, the rollback version and one additional
// historical snapshot even when every file reaches the upload limit.
export const TOP_DASHBOARD_DATA_STORAGE_LIMIT_BYTES = TOP_DASHBOARD_DATA_STORED_MAX_BYTES * 3;

export const TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES = 512 * 1024;
