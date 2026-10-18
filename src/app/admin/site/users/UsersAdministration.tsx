'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminUsersSection } from '@/features/admin/users/AdminUsersSection';
import { AdminStatusToast } from '@/features/admin/shared/AdminStatusToast';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import { AdminTopbar } from '../../AdminTopbar';
import styles from '../../admin.module.scss';

/** Delegated user management without site settings, privileged hooks or the site sidebar. */
export function UsersAdministration() {
  const router = useRouter();
  const [status, setStatus] = useState('');
  const logoutPending = useRef(false);
  const { request, isActive } = useAdminRequestScope();
  const logout = async () => {
    if (logoutPending.current) return;
    logoutPending.current = true;
    try {
      const response = await request('/api/admin/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Не удалось завершить сеанс. Повторите выход.');
      if (isActive()) router.replace('/login?mode=employee');
    } catch (error) {
      if (isActive()) setStatus(error instanceof Error ? error.message : 'Не удалось завершить сеанс.');
    } finally {
      logoutPending.current = false;
    }
  };
  return <main className={styles.page}>
    <AdminTopbar activeArea="site" pageTitle="Пользователи и доступы" onBackToHome={() => router.push('/admin')}
      onLogout={logout} />
    <AdminStatusToast message={status} />
    <AdminUsersSection canManageSiteAdmins={false} showStatus={setStatus} />
  </main>;
}
