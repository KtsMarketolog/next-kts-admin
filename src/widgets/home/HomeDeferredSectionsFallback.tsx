import styles from "./HomeDeferredSectionsFallback.module.scss";

const groupCards = Array.from({ length: 5 });
const facts = Array.from({ length: 3 });
const advantages = Array.from({ length: 8 });
const promotions = Array.from({ length: 5 });
const products = Array.from({ length: 8 });
const news = Array.from({ length: 3 });
const tabs = Array.from({ length: 7 });
const brands = Array.from({ length: 15 });

export function HomeDeferredSectionsFallback() {
  return (
    <div aria-hidden="true" className={styles.root}>
      <section className={styles.section}>
        <div className={styles.heading} />
        <div className={styles.groupGrid}>
          {groupCards.map((_, index) => (
            <div key={index} className={styles.groupCard} />
          ))}
        </div>
      </section>

      <section className={`${styles.section} ${styles.sectionNarrow} ${styles.aboutSection}`}>
        <div className={styles.heading} />
        <div className={styles.aboutGrid}>
          <div className={styles.aboutBig} />
          <div className={styles.facts}>
            {facts.map((_, index) => (
              <div key={index} className={styles.factCard} />
            ))}
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.heading} />
        <div className={styles.advantageBand}>
          <div className={styles.advantageGrid}>
            {advantages.map((_, index) => (
              <div key={index} className={styles.advantageCard} />
            ))}
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.partnerBanner} />
      </section>

      <section className={`${styles.section} ${styles.sectionNarrow}`}>
        <div className={styles.heading} />
        <div className={styles.promoGrid}>
          {promotions.map((_, index) => (
            <div
              key={index}
              className={`${styles.promoCard} ${index > 1 ? styles.promoWide : ""}`}
            />
          ))}
        </div>
      </section>

      <section className={styles.productsBand}>
        <div className={styles.sectionNarrow}>
          <div className={styles.heading} />
          <div className={styles.productGrid}>
            {products.map((_, index) => (
              <div key={index} className={styles.productCard} />
            ))}
            <div className={styles.catalogButton} />
          </div>
        </div>
      </section>

      <section className={`${styles.section} ${styles.sectionNarrow}`}>
        <div className={styles.heading} />
        <div className={styles.newsGrid}>
          {news.map((_, index) => (
            <div key={index} className={styles.newsCard}>
              <div className={styles.newsImage} />
              <div className={styles.newsLine} />
              <div className={styles.newsLine} />
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.heading} />
        <div className={styles.tabsBand}>
          <div className={styles.tabs}>
            {tabs.map((_, index) => (
              <div key={index} className={styles.tab} />
            ))}
          </div>
        </div>
        <div className={styles.brandGrid}>
          {brands.map((_, index) => (
            <div key={index} className={styles.brandCard} />
          ))}
        </div>
      </section>
    </div>
  );
}
