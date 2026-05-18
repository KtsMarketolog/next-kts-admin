'use client';

import { useEffect } from 'react';

import styles from './AboutKTS.module.scss';

type AboutKTSRevealProps = {
  rootId: string;
};

export function AboutKTSReveal({ rootId }: AboutKTSRevealProps) {
  useEffect(() => {
    const node = document.getElementById(rootId);
    if (!node) return undefined;

    const reveal = () => node.classList.add(styles.revealed);
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion || !('IntersectionObserver' in window)) {
      reveal();
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        reveal();
        observer.disconnect();
      },
      { threshold: 0.2 },
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [rootId]);

  return null;
}
