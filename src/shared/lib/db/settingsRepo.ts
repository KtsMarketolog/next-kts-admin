import { DEFAULT_ADDRESS, DEFAULT_EMAIL, DEFAULT_PHONE } from '../phone';
import { query } from './client';
import { ensureSiteSchema } from './schema';

export async function getPhoneSetting() {
  const settings = await getSiteSettings();
  return settings.phone;
}

export async function updatePhoneSetting(phone: string) {
  await updateSiteSettings({ phone });
}

export async function getSiteSettings() {
  await ensureSiteSchema();
  const result = await query<{ key: string; value: string }>(
    `select key, value from site_settings where key in ('phone', 'email', 'address')`,
  );
  const settings = Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
  return {
    phone: settings.phone ?? DEFAULT_PHONE,
    email: settings.email ?? DEFAULT_EMAIL,
    address: settings.address ?? DEFAULT_ADDRESS,
  };
}

export async function updateSiteSettings(settings: { phone?: string; email?: string; address?: string }) {
  await ensureSiteSchema();
  const entries = Object.entries(settings).filter(
    (entry): entry is [keyof typeof settings, string] => typeof entry[1] === 'string',
  );

  for (const [key, value] of entries) {
    await query(
      `insert into site_settings (key, value, updated_at)
       values ($1, $2, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, value],
    );
  }
}
