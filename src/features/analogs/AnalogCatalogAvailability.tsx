import styles from './AnalogFinder.module.scss';

export type AnalogCatalogStock = {
  productId: number;
  title: string;
  sku: string;
  model: string;
  stock: number;
  stockVolzhsk: number;
  stockMoscow: number;
  unit: string;
  isExpected: boolean;
};

export function AnalogCatalogAvailability({ items }: { items: AnalogCatalogStock[] }) {
  return <div className={styles.catalogAvailability}>
    {items.length > 1 ? <p>В каталоге несколько позиций. Остатки показаны отдельно для каждого артикула.</p> : null}
    {items.map((item) => <div className={styles.catalogItem} key={item.productId}>
      <strong>{item.title}</strong>
      <span>Артикул: {item.sku || 'не указан'}</span>
      <span className={item.stock > 0 ? styles.stockAvailable : item.isExpected ? styles.stockExpected : styles.stockOrder}>
        {item.stock > 0 ? `Всего: ${item.stock} ${item.unit}` : item.isExpected ? 'Ожидается поступление' : 'Нет на складе'}
      </span>
      <span>Москва: {item.stockMoscow} {item.unit} · Волжск: {item.stockVolzhsk} {item.unit}</span>
    </div>)}
  </div>;
}
