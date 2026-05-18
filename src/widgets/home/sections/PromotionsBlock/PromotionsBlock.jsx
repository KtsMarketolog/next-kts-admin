import { HorizontalScrollGrid } from '@/widgets/home/sections/shared/HorizontalScrollGrid';
import styles from './PromotionsBlock.module.scss';

const promos = Array.from({ length: 5 });

export const PromotionsBlock = () => {
  return (
    <section className={styles.promotionsBlock} id="sales">
      <HorizontalScrollGrid
        title="АКЦИИ"
        titleClassName={styles.title}
        titleArrowClassName={styles.titleArrow}
        gridClassName={styles.grid}
        scrolledClassName={styles.scrolled}
        scrollAmount={200}
        arrowLabel="Прокрутить акции"
      >
        {promos.map((_, idx) => (
          <div key={idx} className={styles.card}>
            <div className={styles.cardContent}>
              <div className={styles.cardTitle} />
              <div className={styles.cardSubtitle} />
            </div>
          </div>
        ))}
      </HorizontalScrollGrid>
    </section>
  );
};
