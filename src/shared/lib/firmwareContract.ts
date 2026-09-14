// Shared by the admin UI and server. No filesystem or credential dependencies.
export const MAX_FIRMWARE_BYTES = 25 * 1024 * 1024;
export const MAX_VERSION_BYTES = 4 * 1024;
export const MAX_FIRMWARE_BODY_BYTES = MAX_FIRMWARE_BYTES + 128 * 1024;
export const MAX_FIRMWARE_STORAGE_BYTES = 250 * 1024 * 1024;

export const FIRMWARE_FILES = {
  c23: { fileName: 'hse_gen_1.c23', maxBytes: MAX_FIRMWARE_BYTES, url: 'http://kts-impex.ru/klimatika/prog/firmware/update/hse/gen_1/hse_gen_1.c23' },
  ver: { fileName: 'hse_gen_1.ver', maxBytes: MAX_VERSION_BYTES, url: 'http://kts-impex.ru/klimatika/prog/firmware/update/hse/gen_1/hse_gen_1.ver' },
} as const;
export type FirmwareKind = keyof typeof FIRMWARE_FILES;
export type FirmwareFileInfo = { fileName: string; size: number; sha256: string; url: string };
export type FirmwareVersion = {
  id: string;
  createdAt: string;
  versionLabel: string | null;
  files: Record<FirmwareKind, FirmwareFileInfo>;
};
export type FirmwareOverview = {
  revision: string;
  current: FirmwareVersion | null;
  previous: FirmwareVersion | null;
  storageBytes: number;
};

export class FirmwareError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'FirmwareError';
  }
}
