import styles from "./CatalogSidebarSkeleton.module.scss";

const rows = Array.from({ length: 7 });

export function CatalogSidebarSkeleton() {
  return (
    <div className={styles.wrap} aria-hidden="true">
      <div className={styles.tabs}>
        <div className={styles.tab} />
        <div className={styles.tab} />
      </div>
      <div className={styles.search} />
      <div className={styles.tree}>
        {rows.map((_, index) => (
          <div
            key={index}
            className={`${styles.node} ${index === 1 || index === 4 ? styles.nodeTall : ""}`}
          />
        ))}
      </div>
    </div>
  );
}
