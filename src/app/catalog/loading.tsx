import styles from './loading.module.scss';

const cards = Array.from({ length: 8 });

export default function Loading() {
  return (
    <div className={styles.wrap} aria-hidden="true">
      <div className={styles.titleSkel} />
      <div className={styles.grid}>
        {cards.map((_, index) => (
          <div key={index} className={styles.card}>
            <div className={styles.lineWide} />
            <div className={styles.lineShort} />
            <div className={styles.picture} />
          </div>
        ))}
      </div>
    </div>
  );
}
