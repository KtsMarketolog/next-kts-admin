import Link from 'next/link';
import styles from './SubcategoryGrid.module.scss';

type Subcategory = { slug: string; title: string };

export default function SubcategoryGrid({
  items,
  categorySlug,
}: { items: Subcategory[]; categorySlug: string }) {
  if (!items?.length) return <div className={styles.empty}>Подкатегорий пока нет</div>;

  return (
    <div className={styles.grid}>
      {items.map((s) => (
        <Link
          key={s.slug}
          href={`/catalog/${categorySlug}/${s.slug}`}
          className={styles.card}
        >
          <span className={styles.cardText}>{s.title}</span>
        </Link>
      ))}
    </div>
  );
}
