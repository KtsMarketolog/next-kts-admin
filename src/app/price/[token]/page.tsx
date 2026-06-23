import { notFound } from 'next/navigation';

import { getPublicWholesalePriceList } from '@/shared/lib/db';
import { phoneHref } from '@/shared/lib/phone';

import { PriceAnalyticsTracker } from './PriceAnalyticsTracker';
import { PriceEventLink } from './PriceEventLink';
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
  const hasSupportManagerContact = Boolean(
    priceList.supportManagerName || priceList.supportManagerPhone || priceList.supportManagerEmail,
  );

  return (
    <main className={styles.page}>
      <PriceAnalyticsTracker token={priceList.token} />
      <div className={styles.shell}>
        <section className={styles.hero}>
          <div className={styles.heroMain}>
            <p>Индивидуальный прайс</p>
            <h1>{priceList.title}</h1>
            {priceList.clientName ? <p>Клиент: {priceList.clientName}</p> : null}
            {priceList.validUntil ? <p>Действует до: {priceList.validUntil}</p> : null}
          </div>
          <div className={styles.heroSide}>
            {hasManagerContact || hasSupportManagerContact ? (
              <div className={styles.managerContacts}>
                {hasManagerContact ? (
                  <aside className={styles.managerContact}>
                    <span>Ваш менеджер по развитию</span>
                    {priceList.managerName ? <strong>{priceList.managerName}</strong> : null}
                    {priceList.managerPhone ? (
                      <PriceEventLink href={phoneHref(priceList.managerPhone)} token={priceList.token} eventType="public_price_phone_clicked">
                        {priceList.managerPhone}
                      </PriceEventLink>
                    ) : null}
                    {priceList.managerEmail ? (
                      <PriceEventLink href={`mailto:${priceList.managerEmail}`} token={priceList.token} eventType="public_price_email_clicked">
                        {priceList.managerEmail}
                      </PriceEventLink>
                    ) : null}
                  </aside>
                ) : null}
                {hasSupportManagerContact ? (
                  <aside className={styles.managerContact}>
                    <span>Ваш менеджер по сопровождению</span>
                    {priceList.supportManagerName ? <strong>{priceList.supportManagerName}</strong> : null}
                    {priceList.supportManagerPhone ? (
                      <PriceEventLink href={phoneHref(priceList.supportManagerPhone)} token={priceList.token} eventType="public_price_phone_clicked">
                        {priceList.supportManagerPhone}
                      </PriceEventLink>
                    ) : null}
                    {priceList.supportManagerEmail ? (
                      <PriceEventLink href={`mailto:${priceList.supportManagerEmail}`} token={priceList.token} eventType="public_price_email_clicked">
                        {priceList.supportManagerEmail}
                      </PriceEventLink>
                    ) : null}
                  </aside>
                ) : null}
              </div>
            ) : null}
            <div className={styles.downloadActions}>
              <a className={styles.pdfButton} href={`/price/${priceList.token}/pdf`}>
                Скачать PDF
              </a>
              <a className={styles.excelButton} href={`/price/${priceList.token}/excel`}>
                Скачать Excel
              </a>
            </div>
          </div>
        </section>

        {priceList.categories.length === 0 ? (
          <section className={styles.category}>
            <p className={styles.empty}>В прайс пока не добавлены товары.</p>
          </section>
        ) : (
          <PriceRequestForm
            token={priceList.token}
            categories={priceList.categories}
            showRetailPrices={priceList.showRetailPrices}
          />
        )}
      </div>
    </main>
  );
}
