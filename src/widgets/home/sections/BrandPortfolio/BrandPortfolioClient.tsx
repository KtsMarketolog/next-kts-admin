'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { ArrowCircleRightIcon } from '@/shared/icons/ArrowCircleRightIcon';
import Container from '@/shared/ui/Container';
import styles from './BrandPortfolio.module.scss';

type BrandCategory = {
  id: number;
  key: string;
  title: string;
  sortOrder?: number;
  isActive?: boolean;
};

type BrandItem = {
  id: number;
  categoryId: number;
  name: string;
  imageUrl?: string | null;
  iconKey?: string;
  sortOrder?: number;
  isActive?: boolean;
};

type BrandPortfolioData = {
  categories: BrandCategory[];
  brands: BrandItem[];
};

type BrandPortfolioClientProps = {
  initialCategories?: BrandCategory[];
  initialBrands?: BrandItem[];
};

const ROOT_ID = 'brand-portfolio';

function normalizePortfolio(categories?: BrandCategory[], brands?: BrandItem[]): BrandPortfolioData {
  return {
    categories: Array.isArray(categories) ? categories : [],
    brands: Array.isArray(brands) ? brands : [],
  };
}

function hasPortfolio(data: BrandPortfolioData) {
  return data.categories.length > 0 && data.brands.length > 0;
}

export function BrandPortfolioClient({ initialCategories = [], initialBrands = [] }: BrandPortfolioClientProps) {
  const [portfolio, setPortfolio] = useState(() => normalizePortfolio(initialCategories, initialBrands));
  const [activeKey, setActiveKey] = useState(() => portfolio.categories[0]?.key || '');
  const [isLoading, setIsLoading] = useState(() => !hasPortfolio(portfolio));
  const [isAtEnd, setIsAtEnd] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hasPortfolio(portfolio)) return;

    let isMounted = true;

    async function loadPortfolio() {
      try {
        const response = await fetch('/api/brand-portfolio', { cache: 'no-store' });
        if (!response.ok) return;

        const data = (await response.json()) as Partial<BrandPortfolioData>;
        const normalized = normalizePortfolio(data.categories, data.brands);

        if (!isMounted || !hasPortfolio(normalized)) return;

        setPortfolio(normalized);
        setActiveKey((current) => current || normalized.categories[0]?.key || '');
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadPortfolio();

    return () => {
      isMounted = false;
    };
  }, [portfolio]);

  const brandsByCategory = useMemo(() => {
    const result = new Map<number, BrandItem[]>();

    for (const brand of portfolio.brands) {
      const categoryBrands = result.get(brand.categoryId) || [];
      categoryBrands.push(brand);
      result.set(brand.categoryId, categoryBrands);
    }

    return result;
  }, [portfolio.brands]);

  const updateScrollState = () => {
    const tabs = tabsRef.current;
    if (!tabs) return;

    setIsAtEnd(tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 2);
  };

  const handleArrowClick = () => {
    const tabs = tabsRef.current;
    if (!tabs) return;

    const scrollAmount = 200;
    const distanceToEnd = tabs.scrollWidth - tabs.clientWidth - tabs.scrollLeft;
    const distanceToStart = tabs.scrollLeft;
    const amount = isAtEnd ? Math.min(distanceToStart, scrollAmount) : Math.min(distanceToEnd, scrollAmount);

    tabs.scrollBy({
      left: isAtEnd ? -amount : amount,
      behavior: 'smooth',
    });
  };

  return (
    <section className={styles.brandPortfolio} id={ROOT_ID}>
      <div className={styles.title}>
        Портфель брендов
        <button
          type="button"
          className={`${styles.titleArrow} ${isAtEnd ? styles.rotated : ''}`}
          onClick={handleArrowClick}
          aria-label="Прокрутить категории брендов"
        >
          <ArrowCircleRightIcon />
        </button>
      </div>

      <div className={styles.tabsWrapper}>
        <div
          className={styles.tabs}
          ref={tabsRef}
          onScroll={updateScrollState}
          role="tablist"
          aria-label="Категории брендов"
        >
          {portfolio.categories.map((tab) => {
            const isActive = tab.key === activeKey;

            return (
              <button
                key={tab.id}
                type="button"
                className={`${styles.tabButton} ${isActive ? styles.active : ''}`}
                onClick={() => setActiveKey(tab.key)}
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
        {portfolio.categories.length > 0 ? (
          portfolio.categories.map((category) => {
            const categoryBrands = brandsByCategory.get(category.id) || [];

            return (
              <div
                key={category.id}
                className={styles.grid}
                role="tabpanel"
                hidden={category.key !== activeKey}
              >
                {categoryBrands.length > 0 ? (
                  categoryBrands.map((brand) => (
                    <div key={brand.id} className={styles.card}>
                      {brand.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={brand.imageUrl} alt={brand.name} loading="lazy" decoding="async" />
                      ) : (
                        brand.name
                      )}
                    </div>
                  ))
                ) : (
                  !isLoading && <div className={styles.placeholder}>Бренды появятся позже</div>
                )}
              </div>
            );
          })
        ) : (
          <div className={styles.grid}>
            {!isLoading && <div className={styles.placeholder}>Бренды появятся позже</div>}
          </div>
        )}
      </Container>
    </section>
  );
}
