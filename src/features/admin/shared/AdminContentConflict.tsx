import styles from '@/app/admin/admin.module.scss';

export function AdminContentConflict({ visible, busy, onReload }: {
  visible: boolean; busy: boolean; onReload: () => Promise<void>;
}) {
  if (!visible) return null;
  return <div role="alert" className={`${styles.draftNotice} ${styles.contentConflict}`}>
    <p>Запись уже изменена другим администратором. Ваши правки не сохранены и остаются в форме. Скопируйте нужный текст перед загрузкой актуальной версии.</p>
    <button type="button" className={styles.secondary} disabled={busy} onClick={() => void onReload()}>
      Загрузить актуальную версию
    </button>
  </div>;
}
