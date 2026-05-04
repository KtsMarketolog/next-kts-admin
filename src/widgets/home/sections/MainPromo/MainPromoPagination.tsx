"use client";

import styles from "./MainPromo.module.scss";

type MainPromoPaginationProps = {
  count: number;
  activeIndex: number;
  onSelect: (index: number) => void;
};

export function MainPromoPagination({ count, activeIndex, onSelect }: MainPromoPaginationProps) {
  return (
    <div className={styles.pagination}>
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={`${styles.dot} ${activeIndex === index ? styles.active : ""}`}
          onClick={() => onSelect(index)}
        />
      ))}
    </div>
  );
}
