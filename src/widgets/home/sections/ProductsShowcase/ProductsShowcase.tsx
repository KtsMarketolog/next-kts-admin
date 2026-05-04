import Container from '@/shared/ui/Container';
import styles from './ProductsShowcase.module.scss';
import Button from '@/shared/ui/Button/Button';
import Link from 'next/link';

const products = [
  {
    title: "Компрессоры",
    desc: "Спиральные, поршневые, винтовые компрессоры",
    iconSrc: "/img/company-products/compressor.png",
    iconAlt: "Компрессоры",
  },
  {
    title: "Нагревательные элементы",
    desc: "ТЭНы, ПЭНы, подогреватели картера",
    iconSrc: "/img/company-products/heating-elements.png",
    iconAlt: "Нагревательные элементы",
  },
  {
    title: "Медные трубы",
    desc: "Медные трубы и фитинги",
    iconSrc: "/img/company-products/copper-pipes.png",
    iconAlt: "Медные трубы",
  },
  {
    title: "Вентиляторы и микродвигатели",
    desc: "Осевые и центробежные вентиляторы",
    iconSrc: "/img/company-products/fans-micromotors.png",
    iconAlt: "Вентиляторы и микродвигатели",
  },
  {
    title: "Сосуды давления",
    desc: "Отделители жидкости, ресиверы, регуляторы уровня масла",
    iconSrc: "/img/company-products/pressure-vessels.png",
    iconAlt: "Сосуды давления",
  },
  {
    title: "Теплообменное оборудование",
    desc: "Воздухоохладители, конденсаторы",
    iconSrc: "/img/company-products/heat-exchange-equipment.png",
    iconAlt: "Теплообменное оборудование",
  },
  {
    title: "Электронные компоненты",
    desc: "Контроллеры, датчики системы мониторинга",
    iconSrc: "/img/company-products/control-units.png",
    iconAlt: "Электронные компоненты",
  },
  {
    title: "Линейные компоненты",
    desc: "ТРВ, ЭРВ, фильтра, магнитные катушки, соленоидные вентили и клапаны",
    iconSrc: "/img/company-products/linear-automation.png",
    iconAlt: "Линейные компоненты",
  },
];

export const ProductsShowcase = () => (
  <section className={styles.productsShowcase} id="catalog">
    <div className={styles.bgBox}>
      <Container>
        <h2 className={styles.title}>Продукция компании</h2>

        <div className={styles.grid}>
          {products.map((product, idx) => {
            if (idx === 6) {
              return [
                <div key={product.title + idx} className={styles.card}>
                  {product.iconSrc && (
                    <div className={styles.iconWrap}>
                      <img
                        src={product.iconSrc}
                        alt={product.iconAlt || product.title}
                        className={styles.iconImg}
                        loading="lazy"
                        decoding="async"
                      />
                    </div>
                  )}

                  <div className={styles.cardTitle}>{product.title}</div>
                  <div className={styles.cardDesc}>{product.desc}</div>
                </div>,

                <div key={`button-${idx}`} className={styles.buttonWrap}>
                  <Link href="/catalog" className={styles.linkFull}>
                    <Button variant="primary" className={styles.btnFull}>
                      В каталог &gt;
                    </Button>
                  </Link>
                </div>,
              ];
            }

            return (
              <div key={product.title + idx} className={styles.card}>
                {product.iconSrc && (
                  <div className={styles.iconWrap}>
                    <img
                      src={product.iconSrc}
                      alt={product.iconAlt || product.title}
                      className={styles.iconImg}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                )}

                <div className={styles.cardTitle}>{product.title}</div>
                <div className={styles.cardDesc}>{product.desc}</div>
              </div>
            );
          })}
        </div>
      </Container>
    </div>
  </section>
);
