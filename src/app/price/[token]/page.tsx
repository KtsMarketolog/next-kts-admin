import { notFound } from 'next/navigation';

import { getPublicWholesalePriceList } from '@/shared/lib/db';
import { phoneHref } from '@/shared/lib/phone';

import { PriceAnalyticsTracker } from './PriceAnalyticsTracker';
import { PriceRequestForm } from './PriceRequestForm';
import styles from './PricePage.module.scss';

type PricePageProps = {
  params: Promise<{ token: string }>;
};

export const dynamic = 'force-dynamic';

export default async function PricePage({ params }: PricePageProps) {
  const { token } = await params;
  const priceList = await getPublicWholesalePriceList(token);

  if (!priceList) notFound();

  const hasManagerContact = Boolean(priceList.managerName || priceList.managerPhone || priceList.managerEmail);

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
          <div className={styles.heroSide}>
            {hasManagerContact ? (
              <aside className={styles.managerContact}>
                <span>Ваш менеджер по прайсу</span>
                {priceList.managerName ? <strong>{priceList.managerName}</strong> : null}
                {priceList.managerPhone ? <a href={phoneHref(priceList.managerPhone)}>{priceList.managerPhone}</a> : null}
                {priceList.managerEmail ? <a href={`mailto:${priceList.managerEmail}`}>{priceList.managerEmail}</a> : null}
              </aside>
            ) : null}
            <a className={styles.pdfButton} href={`/price/${priceList.token}/pdf`}>
              Скачать PDF
            </a>
          </div>
        </section>

        {priceList.categories.length === 0 ? (
          <section className={styles.category}>
            <p className={styles.empty}>В прайс пока не добавлены товары.</p>
          </section>
        ) : (
          <PriceRequestForm
            token={priceList.token}
            showRetailPrices={priceList.showRetailPrices}
            categories={priceList.categories}
          />
        )}
      </div>
    </main>
  );
}
