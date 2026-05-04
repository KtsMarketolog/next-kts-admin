// src/app/catalog/loading.tsx
import styles from './loading.module.scss';

export default function Loading() {
  return (
    <div className={styles.wrap}>
      <div className={styles.titleSkel} />
      <div className={styles.grid}>
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className={styles.card} />)}
      </div>
    </div>
  );
}
