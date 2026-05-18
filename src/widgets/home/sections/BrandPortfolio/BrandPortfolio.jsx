'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Container from '@/shared/ui/Container';
import styles from './BrandPortfolio.module.scss';
import { ArrowCircleRightIcon } from '@/shared/icons/ArrowCircleRightIcon';

/**
 * @param {{
 *   initialCategories?: Array<{ id: number; key: string; title: string; sortOrder?: number; isActive?: boolean }>;
 *   initialBrands?: Array<{ id: number; categoryId: number; name: string; imageUrl: string; iconKey?: string; sortOrder?: number; isActive?: boolean }>;
 * }} props
 */
export const BrandPortfolio = ({ initialCategories = [], initialBrands = [] }) => {
  const categories = useMemo(
    () => (Array.isArray(initialCategories) ? initialCategories : []),
    [initialCategories],
  );
  const brands = useMemo(
    () => (Array.isArray(initialBrands) ? initialBrands : []),
    [initialBrands],
  );
  const [activeTab, setActiveTab] = useState(() => categories[0]?.key || '');
  const [scrollDirection, setScrollDirection] = useState('right');
  const tabsRef = useRef(null);

  useEffect(() => {
    setActiveTab((current) => current || categories[0]?.key || '');
  }, [categories]);

  const scrollTabs = () => {
    if (!tabsRef.current) return;

    const container = tabsRef.current;
    const scrollAmount = 200;

    if (scrollDirection === 'right') {
      const distanceToEnd = container.scrollWidth - container.clientWidth - container.scrollLeft;
      container.scrollBy({ left: Math.min(distanceToEnd, scrollAmount), behavior: 'smooth' });
      setTimeout(() => {
        if (container.scrollLeft + container.clientWidth >= container.scrollWidth - 2) {
          setScrollDirection('left');
        }
      }, 400);
      return;
    }

    const distanceToStart = container.scrollLeft;
    container.scrollBy({ left: -Math.min(distanceToStart, scrollAmount), behavior: 'smooth' });
    setTimeout(() => {
      if (container.scrollLeft <= 2) {
        setScrollDirection('right');
      }
    }, 400);
  };

  useEffect(() => {
    const container = tabsRef.current;
    if (!container) return undefined;

    const handleScroll = () => {
      if (container.scrollLeft <= 2) {
        setScrollDirection('right');
      } else if (container.scrollLeft + container.clientWidth >= container.scrollWidth - 2) {
        setScrollDirection('left');
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  const activeCategory = categories.find((category) => category.key === activeTab);
  const activeBrands = activeCategory
    ? brands.filter((brand) => brand.categoryId === activeCategory.id)
    : [];

  return (
    <section className={styles.brandPortfolio}>
      <div className={styles.title}>
        Портфель брендов
        <div
          className={styles.titleArrow}
          onClick={scrollTabs}
          style={{
            transform: scrollDirection === 'left' ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.3s ease',
          }}
        >
          <ArrowCircleRightIcon />
        </div>
      </div>

      <div className={styles.tabsWrapper}>
        <div className={styles.tabs} ref={tabsRef}>
          {categories.map((tab) => (
            <button
              key={tab.id}
              className={`${styles.tabButton} ${activeTab === tab.key ? styles.active : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.title}
            </button>
          ))}
        </div>
      </div>

      <Container>
        <div className={styles.grid}>
          {activeBrands.length > 0 ? (
            activeBrands.map((brand) => (
              <div key={brand.id} className={styles.card}>
                {brand.imageUrl ? <img src={brand.imageUrl} alt={brand.name} loading="lazy" decoding="async" /> : brand.name}
              </div>
            ))
          ) : (
            <div className={styles.placeholder}>Бренды появятся позже</div>
          )}
        </div>
      </Container>
    </section>
  );
};
