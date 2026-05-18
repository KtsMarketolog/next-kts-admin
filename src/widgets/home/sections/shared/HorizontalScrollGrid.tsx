'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';

import { ArrowCircleRightIcon } from '@/shared/icons/ArrowCircleRightIcon';

type HorizontalScrollGridProps = {
  title: ReactNode;
  titleClassName: string;
  titleArrowClassName: string;
  gridClassName: string;
  children: ReactNode;
  scrolledClassName?: string;
  scrollAmount?: number;
  arrowCircleFill?: string;
  arrowLabel?: string;
};

export function HorizontalScrollGrid({
  title,
  titleClassName,
  titleArrowClassName,
  gridClassName,
  children,
  scrolledClassName,
  scrollAmount = 300,
  arrowCircleFill,
  arrowLabel = 'Прокрутить',
}: HorizontalScrollGridProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [scrollDirection, setScrollDirection] = useState<'right' | 'left'>('right');

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return undefined;

    const updateScrollState = () => {
      setScrolled(grid.scrollLeft > 0);

      if (grid.scrollLeft <= 2) {
        setScrollDirection('right');
      } else if (grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 2) {
        setScrollDirection('left');
      }
    };

    grid.addEventListener('scroll', updateScrollState);
    updateScrollState();

    return () => grid.removeEventListener('scroll', updateScrollState);
  }, []);

  const scrollGrid = () => {
    const container = gridRef.current;
    if (!container) return;

    const distanceToEnd = container.scrollWidth - container.clientWidth - container.scrollLeft;
    const distanceToStart = container.scrollLeft;
    const amount =
      scrollDirection === 'right'
        ? Math.min(distanceToEnd, scrollAmount)
        : Math.min(distanceToStart, scrollAmount);

    container.scrollBy({
      left: scrollDirection === 'right' ? amount : -amount,
      behavior: 'smooth',
    });
  };

  const gridClasses = scrolled && scrolledClassName ? `${gridClassName} ${scrolledClassName}` : gridClassName;

  return (
    <>
      <div className={titleClassName}>
        {title}
        <button
          type="button"
          className={titleArrowClassName}
          onClick={scrollGrid}
          aria-label={arrowLabel}
          style={{
            transform: scrollDirection === 'left' ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.3s ease',
          }}
        >
          <ArrowCircleRightIcon circleFill={arrowCircleFill} />
        </button>
      </div>

      <div className={gridClasses} ref={gridRef}>
        {children}
      </div>
    </>
  );
}
