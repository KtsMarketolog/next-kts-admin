import { notFound } from 'next/navigation';

import { getPublicWholesalePriceList } from '@/shared/lib/db';

import { PriceAnalyticsTracker } from './PriceAnalyticsTracker';
import styles from './PricePage.module.scss';

type PricePageProps = {
  params: Promise<{ token: string }>;
};

function formatPrice(value: string | null) {
  if (!value) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(number);
}

export const dynamic = 'force-dynamic';

export default async function PricePage({ params }: PricePageProps) {
  const { token } = await params;
  const priceList = await getPublicWholesalePriceList(token);

  if (!priceList) notFound();

  return (
    <main className={styles.page}>
      <PriceAnalyticsTracker token={priceList.token} />
      <div className={styles.shell}>
        <section className={styles.hero}>
          <div>
            <p>Индивидуальный прайс</p>
            <h1>{priceList.title}</h1>
            {priceList.clientName ? <p>Клиент: {priceList.clientName}</p> : null}
            {priceList.validUntil ? <p>Действует до: {priceList.validUntil}</p> : null}
          </div>
          <a className={styles.pdfButton} href={`/api/price/${priceList.token}/pdf`}>
            Скачать PDF
          </a>
        </section>

        {priceList.categories.length === 0 ? (
          <section className={styles.category}>
            <p className={styles.empty}>В прайс пока не добавлены товары.</p>
          </section>
        ) : (
          priceList.categories.map((category) => (
            <section className={styles.category} key={category.id}>
              <h2>{category.title}</h2>
              <div className={styles.products}>
                {category.products.map((product) => (
                  <article className={styles.product} key={product.id}>
                    <div className={styles.imageBox}>
                      {product.imageUrl ? <img src={product.imageUrl} alt="" /> : <span>Нет фото</span>}
                    </div>
                    <div className={styles.productInfo}>
                      <h3>{product.title}</h3>
                      {product.sku ? <p>Артикул: {product.sku}</p> : null}
                      {product.description ? <p>{product.description}</p> : null}
                    </div>
                    <table className={styles.prices}>
                      <thead>
                        <tr>
                          <th>Размер</th>
                          {priceList.showRetailPrices ? <th>Розница</th> : null}
                          <th>Опт</th>
                        </tr>
                      </thead>
                      <tbody>
                        {product.variants.map((variant, index) => (
                          <tr key={`${variant.id ?? 'base'}-${index}`}>
                            <td>{variant.title}</td>
                            {priceList.showRetailPrices ? <td>{formatPrice(variant.retailPrice)}</td> : null}
                            <td>{formatPrice(variant.wholesalePrice)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </article>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </main>
  );
}
