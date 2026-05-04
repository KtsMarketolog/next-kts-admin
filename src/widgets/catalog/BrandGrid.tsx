import Link from 'next/link';
import styles from './BrandGrid.module.scss';
import type { Brand } from '@/entities/catalog/api/catalogApi';

type SubLite = {
  slug: string;
  title: string;
  /** slug категории, к которой относится эта подкатегория */
  category?: string;
};

type BrandWithSubs = Brand & {
  /** Подкатегории, где присутствует бренд (приходит со страницы брендов) */
  subs?: SubLite[];
  /** Полный URL логотипа бренда (если есть в CMS). */
  logo?: string | null;
};

type Props = {
  items: BrandWithSubs[];
  baseHref: string;
  /** strip — «лента» ссылок; grid — карточки */
  variant?: 'grid' | 'strip';
  activeBrandSlug?: string;
  includeAll?: boolean;

  /** Опционально: карта slug категории -> человекочитаемое название */
  catTitleBySlug?: Record<string, string>;
  /** Текст заголовка над сеткой (по умолчанию — «Популярные бренды») */
  heading?: string;
};

export default function BrandGrid({
  items,
  baseHref,
  variant = 'grid',
  activeBrandSlug,
  includeAll = false,
  catTitleBySlug,
  heading = 'Популярные бренды',
}: Props) {
  // ------- Режим «ленты» (полоса ссылок) -------
  if (variant === 'strip') {
    return (
      <div className={styles.strip}>
        {includeAll && (
          <Link
            href={baseHref}
            className={`${styles.brand} ${!activeBrandSlug ? styles.active : ''}`}
          >
            Все
          </Link>
        )}
        {items.map((b) => (
          <Link
            key={b.slug}
            href={`${baseHref}/${b.slug}`}
            className={`${styles.brand} ${activeBrandSlug === b.slug ? styles.active : ''}`}
          >
            {b.title}
          </Link>
        ))}
      </div>
    );
  }

  // ------- Режим карточек брендов -------
  if (!items?.length) {
    return <div className={styles.empty}>Бренды не найдены.</div>;
  }

  return (
    <>
      <h2 className={styles.heading}>{heading}</h2>

      <div className={styles.grid}>
        {items.map((b) => {
          // Из подкатегорий собираем уникальные категории по slug
          const uniqueCatSlugs: string[] = Array.from(
            new Set(
              (b.subs ?? [])
                .map((s) => s.category)
                .filter((x): x is string => !!x)
            )
          );

          return (
            <article key={b.slug} className={styles.card} aria-label={b.title}>
              {/* ВЕРХ: делаем кликабельной всю зону с логотипом */}
              <Link
                href={`${baseHref}/${b.slug}`}
                className={styles.cover}
                aria-label={b.title}
              >
                {b.logo ? (
                  // можно заменить на <Image /> при необходимости
                  <img src={b.logo} alt={b.title} loading="lazy" />
                ) : null}
              </Link>

              <div className={styles.body}>
                <h3 className={styles.title}>
                  <Link href={`${baseHref}/${b.slug}`} className={styles.titleLink}>
                    {b.title}
                  </Link>
                </h3>

                {/* Категории, где встречается бренд */}
                {uniqueCatSlugs.length ? (
                  <div className={styles.subs}>
                    {uniqueCatSlugs.map((catSlug) => {
                      const label = catTitleBySlug?.[catSlug] ?? catSlug;
                      const href = `/catalog/${catSlug}`;
                      return (
                        <Link key={`${b.slug}:${catSlug}`} href={href} className={styles.subLink}>
                          {label}
                        </Link>
                      );
                    })}
                  </div>
                ) : (
                  <div className={styles.subs}>
                    <span className={styles.subLink}>Категории отсутствуют</span>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
