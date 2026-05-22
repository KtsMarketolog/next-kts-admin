import styles from './loading.module.scss';

const categorySkeletons = [0, 1, 2];
const productSkeletons = [0, 1, 2];
const managerSkeletons = [0, 1];

export default function Loading() {
  return (
    <main className={styles.page} aria-busy="true">
      <div className={styles.shell}>
        <section className={styles.hero}>
          <div className={styles.heroMain}>
            <span className={styles.kicker} />
            <span className={styles.title} />
            <span className={styles.subtitle} />
            <span className={styles.meta} />
          </div>
          <div className={styles.heroSide}>
            <div className={styles.managerContacts}>
              {managerSkeletons.map((item) => (
                <div className={styles.managerContact} key={item}>
                  <span />
                  <strong />
                  <i />
                </div>
              ))}
            </div>
            <div className={styles.actions}>
              <span />
              <span />
            </div>
          </div>
        </section>

        <section className={styles.search}>
          <span />
          <strong />
        </section>

        {categorySkeletons.map((category) => (
          <section className={styles.category} key={category}>
            <div className={styles.categoryHeader}>
              <span className={styles.image} />
              <div className={styles.categoryTitle}>
                <strong />
                <span />
              </div>
              <i />
            </div>
            <div className={styles.products}>
              {productSkeletons.map((product) => (
                <div className={styles.product} key={product}>
                  <div className={styles.productInfo}>
                    <strong />
                    <span />
                    <span />
                  </div>
                  <div className={styles.priceTable}>
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
