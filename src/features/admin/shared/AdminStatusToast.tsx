'use client';

import styles from '@/app/admin/admin.module.scss';

type AdminStatusToastProps = {
  message: string;
};

export function AdminStatusToast({ message }: AdminStatusToastProps) {
  if (!message) return null;

  return <div className={styles.status}>{message}</div>;
}
