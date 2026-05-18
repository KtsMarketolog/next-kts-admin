import Container from '@/shared/ui/Container';
import { ArrowCircleRightIcon } from '@/shared/icons/ArrowCircleRightIcon';
import { BrandPortfolioClient } from './BrandPortfolioClient';
import { BrandPortfolioControls } from './BrandPortfolioControls';
import styles from './BrandPortfolio.module.scss';

const ROOT_ID = 'brand-portfolio';

/**
 * @param {{
 *   initialCategories?: Array<{ id: number; key: string; title: string; sortOrder?: number; isActive?: boolean }>;
 *   initialBrands?: Array<{ id: number; categoryId: number; name: string; imageUrl?: string | null; iconKey?: string; sortOrder?: number; isActive?: boolean }>;
 * }} props
 */
export const BrandPortfolio = ({ initialCategories = [], initialBrands = [] }) => {
  const categories = Array.isArray(initialCategories) ? initialCategories : [];
  const brands = Array.isArray(initialBrands) ? initialBrands : [];
  const activeKey = categories[0]?.key || '';

  if (categories.length === 0 || brands.length === 0) {
    return <BrandPortfolioClient initialCategories={categories} initialBrands={brands} />;
  }

  return (
    <section className={styles.brandPortfolio} id={ROOT_ID}>
      <BrandPortfolioControls rootId={ROOT_ID} />

      <div className={styles.title}>
        Портфель брендов
        <button
          type="button"
          className={styles.titleArrow}
          data-brand-tabs-arrow
          aria-label="Прокрутить категории брендов"
        >
          <ArrowCircleRightIcon />
        </button>
      </div>

      <div className={styles.tabsWrapper}>
        <div className={styles.tabs} data-brand-tabs role="tablist" aria-label="Категории брендов">
          {categories.map((tab) => {
            const isActive = tab.key === activeKey;

            return (
              <button
                key={tab.id}
                type="button"
                className={`${styles.tabButton} ${isActive ? styles.active : ''}`}
                data-brand-tab={tab.key}
                role="tab"
                aria-selected={isActive}
              >
                {tab.title}
              </button>
            );
          })}
        </div>
      </div>

      <Container>
        {categories.length > 0 ? (
          categories.map((category) => {
            const categoryBrands = brands.filter((brand) => brand.categoryId === category.id);

            return (
              <div
                key={category.id}
                className={styles.grid}
                data-brand-panel={category.key}
                role="tabpanel"
                hidden={category.key !== activeKey}
              >
                {categoryBrands.length > 0 ? (
                  categoryBrands.map((brand) => (
                    <div key={brand.id} className={styles.card}>
                      {brand.imageUrl ? (
                        <img src={brand.imageUrl} alt={brand.name} loading="lazy" decoding="async" />
                      ) : (
                        brand.name
                      )}
                    </div>
                  ))
                ) : (
                  <div className={styles.placeholder}>Бренды появятся позже</div>
                )}
              </div>
            );
          })
        ) : (
          <div className={styles.grid}>
            <div className={styles.placeholder}>Бренды появятся позже</div>
          </div>
        )}
      </Container>
    </section>
  );
};
