'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminUsersSection } from '@/features/admin/users/AdminUsersSection';
import { AdminStatusToast } from '@/features/admin/shared/AdminStatusToast';
import { AdminTopbar } from '../../AdminTopbar';
import styles from '../../admin.module.scss';

/** Delegated user management without site settings, privileged hooks or the site sidebar. */
export function UsersAdministration() {
  const router = useRouter();
  const [status, setStatus] = useState('');
  return <main className={styles.page}>
    <AdminTopbar activeArea="site" pageTitle="Пользователи и доступы" onBackToHome={() => router.push('/admin')}
      onLogout={async () => { await fetch('/api/admin/logout', { method: 'POST' }); router.replace('/login?mode=employee'); }} />
    <AdminStatusToast message={status} />
    <AdminUsersSection canManageSiteAdmins={false} showStatus={setStatus} />
  </main>;
}
