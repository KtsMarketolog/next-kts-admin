"use client";

import React, { useRef, useEffect, useState } from "react";
import styles from "./NewsBlock.module.scss";
import { ArrowCircleRightIcon } from '@/shared/icons/ArrowCircleRightIcon';
import Button from "@/shared/ui/Button/Button";
import { DEFAULT_NEWS, type NewsItem } from "@/entities/site/model/defaultNews";

export const NewsBlock = () => {

  const gridRef = useRef<HTMLDivElement | null>( null );
  const [ scrolled, setScrolled ] = useState( false );
  const [ scrollDirection, setScrollDirection ] = useState<"right" | "left">("right");
  const [ news, setNews ] = useState<NewsItem[]>(DEFAULT_NEWS);

  useEffect(() => {
    let alive = true;

    fetch('/api/home-news', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (alive && Array.isArray(data?.news)) {
          setNews(data.news);
        }
      })
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {

    const grid = gridRef.current;

    if (!grid) return;

    const onScroll = () => {

      setScrolled(grid.scrollLeft > 0);

      if (grid.scrollLeft <= 2) {

        setScrollDirection("right");

      } else if (

        grid.scrollLeft + grid.clientWidth >=
        grid.scrollWidth - 2

      ) {

        setScrollDirection("left");

      }

    };

    grid.addEventListener("scroll", onScroll);

    onScroll();

    return () => grid.removeEventListener("scroll", onScroll);

  }, []);

  const scrollGrid = () => {

    if (!gridRef.current) return;

    const container = gridRef.current;
    const scrollAmount = 300;

    if (scrollDirection === "right") {
      
      const distanceToEnd = container.scrollWidth - container.clientWidth - container.scrollLeft;
      const amount = distanceToEnd < scrollAmount ? distanceToEnd : scrollAmount;

      container.scrollBy({ left: amount, behavior: "smooth" });

      setTimeout(() => {

        if (

          container.scrollLeft + container.clientWidth >=
          container.scrollWidth - 2

        ) {

          setScrollDirection("left");

        }

      }, 400);
      
    } else {

      const distanceToStart = container.scrollLeft;
      const amount = distanceToStart < scrollAmount ? distanceToStart : scrollAmount;

      container.scrollBy({ left: -amount, behavior: "smooth" });

      setTimeout(() => {

        if (container.scrollLeft <= 2) {

          setScrollDirection("right");

        }

      }, 400);

    }

  };

  return (

    <section className = { styles.newsBlock } id="news">

      <div className = { styles.title }>

        НОВОСТИ

        <div

          className = { styles.titleArrow }
          onClick = { scrollGrid }
          style = { {
            transform:
              scrollDirection === "left"
                ? "rotate(180deg)"
                : "rotate(0deg)",
            transition: "transform 0.3s ease",
          } }

        >

          <ArrowCircleRightIcon circleFill = "#C32133"/>

        </div>

      </div>

      <div

        className = { `${styles.grid} ${scrolled ? styles.scrolled : ''}` }
        ref = { gridRef }

      >

        { news.map((item, idx) => (
          <a

            key={idx}
            href={item.linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className = { styles.card }

          >

            <span className = { styles.date }>{ item.date }</span>

            {/* <div className = { styles.cardTitle }>{ item.title }</div> */}
            <div className={styles.cardTitle}>

              { item.title.split('\n').map((part, i) => (

                <React.Fragment key = { i }>

                  { i > 0 && <br /> }
                  { part }

                </React.Fragment>

              )) }

            </div>

            <div className = { styles.cardImage }>

              <img src = { item.imageUrl } alt = { item.title } />

            </div>

          </a>

        )) }

      </div>

      <div className = { styles.moreButton }>

        <a

          href = "https://t.me/your_channel" 
          target = "_blank"
          rel = "noopener noreferrer"
          className = { styles.moreLink }

        >

          <Button variant = "primary" >Перейти в telegram канал {'>'}</Button>

        </a>

      </div>

    </section>

  );

};
