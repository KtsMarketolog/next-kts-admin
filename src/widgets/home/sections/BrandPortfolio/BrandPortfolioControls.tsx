'use client';

import { useEffect } from 'react';

import styles from './BrandPortfolio.module.scss';

type BrandPortfolioControlsProps = {
  rootId: string;
};

export function BrandPortfolioControls({ rootId }: BrandPortfolioControlsProps) {
  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return undefined;

    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-brand-tab]'));
    const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-brand-panel]'));
    const tabsContainer = root.querySelector<HTMLElement>('[data-brand-tabs]');
    const arrow = root.querySelector<HTMLButtonElement>('[data-brand-tabs-arrow]');
    let scrollDirection: 'right' | 'left' = 'right';

    const setScrollDirectionClass = () => {
      if (!arrow || !tabsContainer) return;

      if (tabsContainer.scrollLeft <= 2) {
        scrollDirection = 'right';
        arrow.classList.remove(styles.rotated);
      } else if (tabsContainer.scrollLeft + tabsContainer.clientWidth >= tabsContainer.scrollWidth - 2) {
        scrollDirection = 'left';
        arrow.classList.add(styles.rotated);
      }
    };

    const activateTab = (key: string) => {
      tabs.forEach((tab) => {
        const isActive = tab.dataset.brandTab === key;
        tab.classList.toggle(styles.active, isActive);
        tab.setAttribute('aria-selected', String(isActive));
      });

      panels.forEach((panel) => {
        panel.hidden = panel.dataset.brandPanel !== key;
      });
    };

    const cleanups = tabs.map((tab) => {
      const handleClick = () => activateTab(tab.dataset.brandTab || '');
      tab.addEventListener('click', handleClick);
      return () => tab.removeEventListener('click', handleClick);
    });

    const handleArrowClick = () => {
      if (!tabsContainer) return;

      const scrollAmount = 200;
      const distanceToEnd = tabsContainer.scrollWidth - tabsContainer.clientWidth - tabsContainer.scrollLeft;
      const distanceToStart = tabsContainer.scrollLeft;
      const amount =
        scrollDirection === 'right'
          ? Math.min(distanceToEnd, scrollAmount)
          : Math.min(distanceToStart, scrollAmount);

      tabsContainer.scrollBy({
        left: scrollDirection === 'right' ? amount : -amount,
        behavior: 'smooth',
      });
    };

    tabsContainer?.addEventListener('scroll', setScrollDirectionClass);
    arrow?.addEventListener('click', handleArrowClick);
    setScrollDirectionClass();

    return () => {
      cleanups.forEach((cleanup) => cleanup());
      tabsContainer?.removeEventListener('scroll', setScrollDirectionClass);
      arrow?.removeEventListener('click', handleArrowClick);
    };
  }, [rootId]);

  return null;
}
