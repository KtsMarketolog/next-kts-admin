// src/app/catalog/_components/ProductGrid.tsx

import styles from './ProductGrid.module.scss';

type ProductUI = {
  id: string;
  slug: string;
  title: string;
  brand?: string;              // slug
  brandTitle?: string | null;
  article?: string | null;     // артикул
  category?: string | null;    // имя категории
  subcategory?: string | null; // имя подкатегории
  stock?: number | null;
  isExpected?: boolean | null;
};

const BRAND_TITLES: Record<string, string> = {

  bitzer: 'Bitzer',
  frascold: 'Frascold',
  refcomp: 'RefComp',
  secop: 'Secop',
  tecumseh: 'Tecumseh',
  cubigel: 'Cubigel',
  invotech: 'Invotech',
  wansheng: 'Wansheng',
  weiguang: 'Weiguang',
  dunli: 'Dunli',
  sanhua: 'Sanhua',
  dixell: 'Dixell',
  lefoo: 'Lefoo',
  frigopoint: 'Frigopoint',
  castel: 'Castel',
  carel: 'Carel',
  danfoss: 'Danfoss',
  hispania: 'Hispania',
  guntner: 'Güntner',
  intercold: 'Intercold',

  // русские варианты
  'alyans-trejd': 'Альянс-Трейд',
  'alyans-treid': 'Альянс-Трейд',

};

function prettyBrandName(brandTitle?: string | null, brandSlug?: string) {

  const fromApi = (brandTitle ?? '').trim();

  if (fromApi) return fromApi;

  if (!brandSlug) return '';
  
  return BRAND_TITLES[brandSlug] ?? brandSlug;

}

export default function ProductGrid({ items }: { items: ProductUI[] }) {

  if (!items?.length) {

    return <div className={styles.empty}>Товары не найдены</div>;

  }

  return (

    <div className={styles.grid}>

      {items.map((p) => {

        const badgeText = prettyBrandName(p.brandTitle, p.brand);
        const article = (p.article ?? '').trim() || '-';
        const cat = (p.category ?? '').trim();
        const sub = (p.subcategory ?? '').trim();

        return (

          <article key={p.id} className={styles.card}>

            <div className={styles.header}>

              <h3 className={styles.title}>{p.title.toUpperCase()}</h3>

              {badgeText && <span className={styles.brandBadge}>{badgeText}</span>}

            </div>

            <div className={styles.meta}>

              <div className={styles.row}>

                <span className={styles.metaLabel}>art.</span>
                <span className={styles.metaValue}>{article}</span>

              </div>

              <div className={styles.tags}>

                {cat && <span className={styles.tag}>#{cat}</span>}
                {sub && <span className={styles.tag}>#{sub}</span>}

              </div>

            </div>

            {/* Заглушка: оверлей без обработчиков — клики никуда не ведут */}
            <span

              className={styles.link}
              aria-hidden="true"
              title="Страница товара скоро будет"

            />

          </article>

        );

      })}

    </div>

  );

}
