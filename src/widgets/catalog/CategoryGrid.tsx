import Link from 'next/link';
import Image from 'next/image';
import type { Category } from '@/entities/catalog/api/catalogApi';
import { mediaUrl } from '@/shared/lib/mediaUrl';
import styles from './CategoryGrid.module.scss';

export default function CategoryGrid({ items }: { items: Category[] }) {
  if (!items?.length) return null;

  return (
    <div className={styles.grid}>
      {items.map((c) => {
        const src = mediaUrl(c.image);
        return (
          <Link key={c.slug} href={`/catalog/${c.slug}`} className={styles.card}>
            <div className={styles.text}>
              <h3 className={styles.title}>{c.title}</h3>
              {c.subtitle && <p className={styles.subtitle}>{c.subtitle}</p>}
            </div>

            {src && (
              <div className={styles.picture}>
                <Image
                  src={src}
                  alt={c.title}
                  fill
                  unoptimized
                  /* Контейнер сам управляет фактическим размером */
                  sizes="100%"
                  style={{ objectFit: 'contain' }}
                  priority={false}
                />
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}
