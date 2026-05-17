'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import styles from './CatalogSidebar.module.scss';
import getSidebarData, {
  fetchBrandsBySubcategory as getBrandsForSubcategory,
} from '@/entities/catalog/api/catalogApiClient';

const DEFAULT_CAT_LINE_COLOR = '#A9AFC0';

const ICON_COLOR_FALLBACKS: Record<string, string> = {
  kompressory: '#E42B34',
  ventilyatory: '#08265c',
  'ventilyatory-i-mikrodvigateli': '#08265c',
  'teploobmennoe-oborudovanie': '#2f0a58',
  'sosudy-davleniya': '#2ba0e3',
  'elektronnye-komponenty': '#fb4f75',
  'lineynye-komponenty': '#1fa355',
  'linejnye-komponenty': '#1fa355',
  'nagrevatelnye-elementy': '#034831',
  'truby-i-fitingi': '#ff601f',
};

type BrandLite = { slug: string; title: string };
type CatLite = {
  slug: string;
  title: string;
  icon?: string;
  subs?: { slug: string; title: string }[];
};
type Hint = { title: string; slug: string };
type IconLineColor = { icon: string; color: string | null };
type CategoryLineStyle = CSSProperties & { '--cat-line': string };

const SALE_SLUG = 'promo';

function toHex(value: number) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

function getSaturation(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function loadIconImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load category icon'));
    image.src = src;
  });
}

function extractIconBackgroundColor(image: HTMLImageElement) {
  const canvas = document.createElement('canvas');
  const size = 48;
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  context.clearRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);

  const pixels = context.getImageData(0, 0, size, size).data;
  const buckets = new Map<string, { r: number; g: number; b: number; weight: number }>();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 90) continue;

    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);

    if (max > 245 && min > 235) continue;
    if (getSaturation(r, g, b) < 0.08 && max > 160) continue;

    const pixel = index / 4;
    const x = pixel % size;
    const y = Math.floor(pixel / size);
    const isEdge = x < 7 || y < 7 || x >= size - 7 || y >= size - 7;
    const weight = isEdge ? 4 : 1;
    const key = `${Math.round(r / 16)},${Math.round(g / 16)},${Math.round(b / 16)}`;
    const current = buckets.get(key) ?? { r: 0, g: 0, b: 0, weight: 0 };

    current.r += r * weight;
    current.g += g * weight;
    current.b += b * weight;
    current.weight += weight;
    buckets.set(key, current);
  }

  const dominant = Array.from(buckets.values()).sort((a, b) => b.weight - a.weight)[0];
  if (!dominant) return null;

  const r = dominant.r / dominant.weight;
  const g = dominant.g / dominant.weight;
  const b = dominant.b / dominant.weight;

  if (getSaturation(r, g, b) < 0.08) return null;

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

async function readIconBackgroundColor(icon: string) {
  const image = await loadIconImage(icon);
  return extractIconBackgroundColor(image);
}

export default function CatalogSidebar() {
  const pathname = usePathname() ?? '';
  const segments = useMemo(() => pathname.split('/').filter(Boolean), [pathname]);

  const inBrands = segments[1] === 'brands';
  const activeCategory = !inBrands && segments.length >= 2 ? segments[1] : null;
  const activeSubcategory =
    !inBrands && segments.length >= 3 && segments[2] !== 'brand' ? segments[2] : null;
  const activeBrand =
    !inBrands && segments[2] && segments[3] === 'brand' ? (segments[4] ?? null) : null;

  const [data, setData] = useState<{ categories: CatLite[]; brands: BrandLite[] } | null>(null);
  const [openCat, setOpenCat] = useState<string | null>(activeCategory);
  const [subBrands, setSubBrands] = useState<BrandLite[]>([]);
  const [query, setQuery] = useState('');
  const [hints, setHints] = useState<Hint[]>([]);
  const [showHints, setShowHints] = useState(false);
  const [iconLineColors, setIconLineColors] = useState<Record<string, IconLineColor>>({});

  // только мобилка: какой дроп открыт
  const [mDrop, setMDrop] = useState<'cats' | 'brands' | null>(null);
  const dropRef = useRef<HTMLDivElement | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const hintsWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let ok = true;
    getSidebarData().then((d) => ok && setData(d));
    return () => {
      ok = false;
    };
  }, []);

  useEffect(() => {
    if (!data) {
      setIconLineColors({});
      return;
    }

    const categoriesWithIcons = data.categories.filter((cat): cat is CatLite & { icon: string } => Boolean(cat.icon));

    setIconLineColors((current) => {
      const next: Record<string, IconLineColor> = {};

      for (const category of categoriesWithIcons) {
        if (current[category.slug]?.icon === category.icon) {
          next[category.slug] = current[category.slug];
        }
      }

      return next;
    });

    let cancelled = false;

    categoriesWithIcons.forEach((category) => {
      readIconBackgroundColor(category.icon)
        .then((color) => {
          if (cancelled) return;

          setIconLineColors((current) => ({
            ...current,
            [category.slug]: {
              icon: category.icon,
              color: color ?? ICON_COLOR_FALLBACKS[category.slug] ?? null,
            },
          }));
        })
        .catch(() => {
          if (cancelled) return;

          setIconLineColors((current) => ({
            ...current,
            [category.slug]: {
              icon: category.icon,
              color: ICON_COLOR_FALLBACKS[category.slug] ?? null,
            },
          }));
        });
    });

    return () => {
      cancelled = true;
    };
  }, [data]);

  useEffect(() => setOpenCat(activeCategory), [activeCategory]);

  useEffect(() => {
    let ok = true;
    if (activeSubcategory) {
      getBrandsForSubcategory(activeSubcategory).then((b) => ok && setSubBrands(b));
    } else {
      setSubBrands([]);
    }
    return () => {
      ok = false;
    };
  }, [activeSubcategory]);

  const categoriesWithSale = useMemo(() => {
    if (!data) return [];
    const sale: CatLite = { slug: SALE_SLUG, title: 'Акции' };
    return [...data.categories, sale];
  }, [data]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHints([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/catalog/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
        const json = await res.json();
        const list: Hint[] = Array.isArray(json)
          ? json
              .map((row: any) => ({
                title: row?.title ?? '',
                slug: row?.slug ?? '',
              }))
              .filter((x: Hint) => x.title && x.slug)
          : [];
        setHints(list);
      } catch {
        /* ignore */
      }
    }, 250);

    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const n = e.target as Node;
      if (!n) return;
      if (!hintsWrapRef.current?.contains(n) && !inputRef.current?.contains(n)) {
        setShowHints(false);
      }
      if (mDrop && dropRef.current && !dropRef.current.contains(n)) {
        const caretClicked = (n as Element).closest?.(`.${styles.tabCaret}`);
        if (!caretClicked) setMDrop(null);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [mDrop]);

  useEffect(() => {
    setMDrop(null);
  }, [pathname]);

  const filteredCategories = useMemo(() => {
    const source = categoriesWithSale;
    const q = query.trim().toLowerCase();
    if (!q) return source;

    return source
      .map((c) => {
        const hitCat = c.title.toLowerCase().includes(q);
        const subs = (c.subs ?? []).filter((s) => s.title.toLowerCase().includes(q));
        return { ...c, subs, __hit: hitCat } as CatLite & { __hit?: boolean };
      })
      .filter((c: any) => c.__hit || (c.subs && c.subs.length));
  }, [categoriesWithSale, query]);

  const filteredBrands = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.brands;
    return data.brands.filter((b) => b.title.toLowerCase().includes(q));
  }, [data, query]);

  const getCategoryLineStyle = (cat: CatLite): CategoryLineStyle => {
    const iconColor = cat.icon ? iconLineColors[cat.slug]?.color : null;

    return {
      '--cat-line': iconColor ?? DEFAULT_CAT_LINE_COLOR,
    };
  };

  return (
    <div className={styles.wrap}>
      {/* Табы */}
      <div className={styles.tabs}>
        {/* ЛЕВАЯ: по категориям */}
        <div className={styles.tabItem}>
          <Link href="/catalog" className={`${styles.tabBtn} ${!inBrands ? styles.active : ''} ${styles.tabLeft}`}>
            <span className={styles.tabIcon} aria-hidden>
              <svg viewBox="0 0 24 24" width="1em" height="1em">
                <rect x="3" y="5" width="18" height="2" rx="1" />
                <rect x="3" y="11" width="18" height="2" rx="1" />
                <rect x="3" y="17" width="18" height="2" rx="1" />
              </svg>
            </span>
            <span>по категориям</span>
          </Link>

          {/* Мобильная «галочка»: раскрыть список категорий вниз */}
          <button
            type="button"
            aria-label="Раскрыть список категорий"
            aria-expanded={mDrop === 'cats'}
            className={`${styles.tabCaret} ${mDrop === 'cats' ? styles.open : ''}`}
            onClick={() => setMDrop((v) => (v === 'cats' ? null : 'cats'))}
          />
        </div>

        {/* ПРАВАЯ: по брендам */}
        <div className={styles.tabItem}>
          <Link
            href="/catalog/brands"
            className={`${styles.tabBtn} ${inBrands ? styles.active : ''} ${styles.tabRight}`}
          >
            <span className={styles.tabIcon} aria-hidden>
              <svg viewBox="0 0 24 24" width="1em" height="1em">
                <path d="M3 7.5V3h4.5l6.9 6.9a2 2 0 0 1 0 2.83l-4.24 4.24a2 2 0 0 1-2.83 0L3 11.5V7.5Z" />
                <circle cx="7" cy="7" r="1.5" />
              </svg>
            </span>
            <span>по брендам</span>
          </Link>

          {/* Мобильная «галочка»: раскрыть список брендов вниз */}
          <button
            type="button"
            aria-label="Раскрыть список брендов"
            aria-expanded={mDrop === 'brands'}
            className={`${styles.tabCaret} ${mDrop === 'brands' ? styles.open : ''}`}
            data-side="right"                             // <-- статично и одинаково на SSR/CSR
            onClick={() => setMDrop((v) => (v === 'brands' ? null : 'brands'))}
          />
        </div>
      </div>

      {/* МОБИЛЬНЫЙ ДРОПДАУН */}
      {mDrop && (
        <div ref={dropRef} className={`${styles.mDrop} ${mDrop === 'cats' ? styles.showCats : styles.showBrands}`}>
          <div className={styles.mDropBox}>
            <div className={styles.mDropHeader}>{mDrop === 'cats' ? 'Категории' : 'Бренды'}</div>

            {mDrop === 'cats' ? (
              <nav className={`${styles.tree} ${styles.treeInDrop}`}>
                {(filteredCategories as CatLite[]).map((cat) => {
                  const isSale = cat.slug === SALE_SLUG;
                  const isOpen = isSale ? false : query.trim() ? true : openCat === cat.slug;

                  return (
                    <div
                      key={`mdrop-cat:${cat.slug}`}
                      className={`${styles.node} ${isOpen ? styles.nodeOpen : ''} ${isSale ? styles.promo : ''}`}
                      style={!isSale ? getCategoryLineStyle(cat) : undefined}
                    >
                      <div className={styles.head}>
                        <Link
                          href={`/catalog/${cat.slug}`}
                          className={`${styles.catLink} ${activeCategory === cat.slug ? styles.isActive : ''}`}
                          onClick={() => setMDrop(null)}
                        >
                          {!isSale && (
                            <span className={styles.catIconBox} aria-hidden>
                              {cat.icon ? (
                                <img
                                  src={cat.icon}
                                  alt=""
                                  width={18}
                                  height={18}
                                  className={styles.catIcon}
                                  loading="lazy"
                                  decoding="async"
                                />
                              ) : (
                                <svg viewBox="0 0 24 24" className={styles.catIcon}>
                                  <path d="M5 7h14v10H5z" fill="currentColor" />
                                </svg>
                              )}
                            </span>
                          )}

                          {isSale && (
                            <span className={styles.catIconBox} aria-hidden>
                              <svg viewBox="0 0 24 24" className={styles.catIcon}>
                                <path
                                  d="M12 2l2.39 4.84L20 8l-4 3.9L17.27 18 12 15.45 6.73 18 8 11.9 4 8l5.61-1.16L12 2z"
                                  fill="currentColor"
                                />
                              </svg>
                            </span>
                          )}

                          <span className={styles.catTitle}>{cat.title}</span>
                        </Link>

                        {!isSale && !!cat.subs?.length && (
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            className={`${styles.toggle} ${isOpen ? styles.open : ''}`}
                            onClick={() => setOpenCat(isOpen ? null : cat.slug)}
                            aria-label={isOpen ? 'Свернуть' : 'Развернуть'}
                          />
                        )}
                      </div>

                      {!isSale && isOpen && !!cat.subs?.length && (
                        <div className={styles.children}>
                          {cat.subs.map((sub) => {
                            const isSubActive = activeSubcategory === sub.slug;
                            return (
                              <div
                                key={`mdrop-sub:${sub.slug}`}
                                className={`${styles.subRow} ${isSubActive ? styles.subActive : ''}`}
                              >
                                <Link
                                  href={`/catalog/${cat.slug}/${sub.slug}`}
                                  className={`${styles.subLink} ${isSubActive && !activeBrand ? styles.isActive : ''}`}
                                  onClick={() => setMDrop(null)}
                                >
                                  {sub.title}
                                </Link>

                                {isSubActive && (
                                  <div className={styles.brandsBlock}>
                                    <Link
                                      href={`/catalog/${cat.slug}/${sub.slug}`}
                                      className={`${styles.brandLink} ${!activeBrand ? styles.isActive : ''}`}
                                      onClick={() => setMDrop(null)}
                                    >
                                      Все
                                    </Link>
                                    {subBrands.map((b) => (
                                      <Link
                                        key={`mdrop-brand:${b.slug}`}
                                        href={`/catalog/${cat.slug}/${sub.slug}/brand/${b.slug}`}
                                        className={`${styles.brandLink} ${activeBrand === b.slug ? styles.isActive : ''}`}
                                        onClick={() => setMDrop(null)}
                                      >
                                        {b.title}
                                      </Link>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </nav>
            ) : (
              <nav className={`${styles.list} ${styles.listInDrop}`}>
                {filteredBrands.map((b) => (
                  <Link
                    key={`mdrop-brand:${b.slug}`}
                    href={`/catalog/brands/${b.slug}`}
                    className={styles.brandLink}
                    onClick={() => setMDrop(null)}
                  >
                    {b.title}
                  </Link>
                ))}
              </nav>
            )}
          </div>
        </div>
      )}

      {/* Поиск */}
      <div className={styles.searchWrap}>
        <label className={styles.search} aria-label="Поиск по товарам и разделам">
          <span className={styles.searchIcon} aria-hidden>
            <svg viewBox="0 0 24 24" width="1em" height="1em">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </span>
          <input
            ref={inputRef}
            type="search"
            placeholder="Что вы хотите найти?"
            value={query}
            onFocus={() => setShowHints(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setShowHints(true);
            }}
          />
        </label>

        {showHints && hints.length > 0 && (
          <div ref={hintsWrapRef} className={styles.hints}>
            {hints.map((h) => (
              <button
                type="button"
                key={h.slug}
                className={styles.hintBtn}
                onMouseDown={() => {
                  setQuery(h.title);
                  setShowHints(false);
                }}
                title={h.title}
              >
                <span className={styles.hintDot} />
                <span className={styles.hintText}>{h.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Сайдбар (десктоп/планшет) */}
      {!data ? null : !inBrands ? (
        <nav className={styles.tree}>
          {(filteredCategories as CatLite[]).map((cat) => {
            const isSale = cat.slug === SALE_SLUG;
            const isOpen = isSale ? false : query.trim() ? true : openCat === cat.slug;

            return (
              <div
                key={`cat:${cat.slug}`}
                className={`${styles.node} ${isOpen ? styles.nodeOpen : ''} ${isSale ? styles.promo : ''}`}
                style={!isSale ? getCategoryLineStyle(cat) : undefined}
              >
                <div className={styles.head}>
                  <Link
                    href={`/catalog/${cat.slug}`}
                    className={`${styles.catLink} ${activeCategory === cat.slug ? styles.isActive : ''}`}
                  >
                    {!isSale && (
                      <span className={styles.catIconBox} aria-hidden>
                        {cat.icon ? (
                          <img
                            src={cat.icon}
                            alt=""
                            width={18}
                            height={18}
                            className={styles.catIcon}
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          <svg viewBox="0 0 24 24" className={styles.catIcon}>
                            <path d="M5 7h14v10H5z" fill="currentColor" />
                          </svg>
                        )}
                      </span>
                    )}

                    {isSale && (
                      <span className={styles.catIconBox} aria-hidden>
                        <svg viewBox="0 0 24 24" className={styles.catIcon}>
                          <path d="M12 2l2.39 4.84L20 8l-4 3.9L17.27 18 12 15.45 6.73 18 8 11.9 4 8l5.61-1.16L12 2z" fill="currentColor" />
                        </svg>
                      </span>
                    )}

                    <span className={styles.catTitle}>{cat.title}</span>
                  </Link>

                  {!isSale && !!cat.subs?.length && (
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      className={`${styles.toggle} ${isOpen ? styles.open : ''}`}
                      onClick={() => setOpenCat(isOpen ? null : cat.slug)}
                      aria-label={isOpen ? 'Свернуть' : 'Развернуть'}
                    />
                  )}
                </div>

                {!isSale && isOpen && !!cat.subs?.length && (
                  <div className={styles.children}>
                    {cat.subs.map((sub) => {
                      const isSubActive = activeSubcategory === sub.slug;
                      return (
                        <div
                          key={`sub:${sub.slug}`}
                          className={`${styles.subRow} ${isSubActive ? styles.subActive : ''}`}
                        >
                          <Link
                            href={`/catalog/${cat.slug}/${sub.slug}`}
                            className={`${styles.subLink} ${isSubActive && !activeBrand ? styles.isActive : ''}`}
                          >
                            {sub.title}
                          </Link>

                          {isSubActive && (
                            <div className={styles.brandsBlock}>
                              <Link
                                href={`/catalog/${cat.slug}/${sub.slug}`}
                                className={`${styles.brandLink} ${!activeBrand ? styles.isActive : ''}`}
                              >
                                Все
                              </Link>
                              {subBrands.map((b) => (
                                <Link
                                  key={`brand:${b.slug}`}
                                  href={`/catalog/${cat.slug}/${sub.slug}/brand/${b.slug}`}
                                  className={`${styles.brandLink} ${activeBrand === b.slug ? styles.isActive : ''}`}
                                >
                                  {b.title}
                                </Link>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      ) : (
        <nav className={styles.list}>
          {filteredBrands.map((b) => (
            <Link key={`brand:${b.slug}`} href={`/catalog/brands/${b.slug}`} className={styles.brandLink}>
              {b.title}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
