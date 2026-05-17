import type { CSSProperties } from 'react';

export type BrandLite = { slug: string; title: string };

export type CatLite = {
  slug: string;
  title: string;
  icon?: string;
  subs?: { slug: string; title: string }[];
};

export type Hint = { title: string; slug: string };

export type IconLineColor = { icon: string; color: string | null };

export type CategoryLineStyle = CSSProperties & { '--cat-line': string };
