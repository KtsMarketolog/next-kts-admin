'use client';

import styles from '@/app/admin/admin.module.scss';
import { SettingKey } from '@/features/admin/types';

type AdminInfoSectionProps = {
  phone: string;
  email: string;
  address: string;
  busy: boolean;
  savedSetting: SettingKey | null;
  onPhoneChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onAddressChange: (value: string) => void;
  onSave: (target: SettingKey) => void;
};

export function AdminInfoSection({
  phone,
  email,
  address,
  busy,
  savedSetting,
  onPhoneChange,
  onEmailChange,
  onAddressChange,
  onSave,
}: AdminInfoSectionProps) {
  const buttonText = (target: SettingKey) => (savedSetting === target ? 'Сохранено' : 'Сохранить');

  return (
    <section className={styles.section}>
      <h2>Информация</h2>
      <div className={styles.infoGrid}>
        <label>
          <span>Телефон</span>
          <input value={phone} onChange={(event) => onPhoneChange(event.target.value)} />
        </label>
        <button
          className={savedSetting === 'phone' ? styles.savedButton : undefined}
          disabled={busy}
          onClick={() => onSave('phone')}
        >
          {buttonText('phone')}
        </button>

        <label>
          <span>Почта</span>
          <input value={email} onChange={(event) => onEmailChange(event.target.value)} />
        </label>
        <button
          className={savedSetting === 'email' ? styles.savedButton : undefined}
          disabled={busy}
          onClick={() => onSave('email')}
        >
          {buttonText('email')}
        </button>

        <label>
          <span>Адрес</span>
          <textarea
            className={styles.addressTextarea}
            value={address}
            onChange={(event) => onAddressChange(event.target.value)}
            rows={2}
          />
        </label>
        <button
          className={savedSetting === 'address' ? styles.savedButton : undefined}
          disabled={busy}
          onClick={() => onSave('address')}
        >
          {buttonText('address')}
        </button>
      </div>
    </section>
  );
}
