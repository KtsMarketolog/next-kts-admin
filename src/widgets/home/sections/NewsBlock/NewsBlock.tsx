import { Fragment } from "react";

import { DEFAULT_NEWS, type NewsItem } from "@/entities/site/model/defaultNews";
import Button from "@/shared/ui/Button/Button";
import { HorizontalScrollGrid } from "@/widgets/home/sections/shared/HorizontalScrollGrid";
import styles from "./NewsBlock.module.scss";

type NewsBlockProps = {
  initialNews?: NewsItem[];
};

export const NewsBlock = ({ initialNews = DEFAULT_NEWS }: NewsBlockProps) => {
  const news = Array.isArray(initialNews) ? initialNews : DEFAULT_NEWS;

  return (
    <section className={styles.newsBlock} id="news">
      <HorizontalScrollGrid
        title="НОВОСТИ"
        titleClassName={styles.title}
        titleArrowClassName={styles.titleArrow}
        gridClassName={styles.grid}
        scrolledClassName={styles.scrolled}
        arrowCircleFill="#C32133"
        arrowLabel="Прокрутить новости"
      >
        {news.map((item, idx) => (
          <a
            key={idx}
            href={item.linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.card}
          >
            <span className={styles.date}>{item.date}</span>

            <div className={styles.cardTitle}>
              {item.title.split('\n').map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && <br />}
                  {part}
                </Fragment>
              ))}
            </div>

            <div className={styles.cardImage}>
              <img src={item.imageUrl} alt={item.title} loading="lazy" decoding="async" />
            </div>
          </a>
        ))}
      </HorizontalScrollGrid>

      <div className={styles.moreButton}>
        <a
          href="https://t.me/your_channel"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.moreLink}
        >
          <Button variant="primary">Перейти в telegram канал {'>'}</Button>
        </a>
      </div>
    </section>
  );
};
