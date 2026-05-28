import styles from '@/app/admin/admin.module.scss';

export function renderWholesaleEditorSkeleton() {
  return (
    <div className={styles.editorSkeleton} aria-busy="true">
      <div className={styles.skeletonEditorGrid}>
        {Array.from({ length: 6 }, (_, index) => (
          <div className={styles.skeletonField} key={index}>
            <span className={styles.skeletonLabelLine} />
            <span className={styles.skeletonInputLine} />
          </div>
        ))}
        <div className={`${styles.skeletonField} ${styles.wholesaleWide}`}>
          <span className={styles.skeletonLabelLine} />
          <span className={styles.skeletonTextareaLine} />
        </div>
      </div>

      <div className={styles.skeletonOptions}>
        <span />
        <span />
        <span />
      </div>

      <div className={styles.skeletonSearchBlock}>
        <span />
        <span />
        <span />
      </div>

      {Array.from({ length: 2 }, (_, groupIndex) => (
        <div className={styles.skeletonPriceGroup} key={groupIndex}>
          <div className={styles.skeletonGroupHeader}>
            <span className={styles.skeletonImage} />
            <span className={styles.skeletonTitleLine} />
            <span className={styles.skeletonWideLine} />
          </div>
          {Array.from({ length: 3 }, (_, productIndex) => (
            <div className={styles.skeletonProductCard} key={productIndex}>
              <div>
                <span className={styles.skeletonTitleLine} />
                <span className={styles.skeletonShortLine} />
                <span className={styles.skeletonShortLine} />
              </div>
              <div className={styles.skeletonVariantGrid}>
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
