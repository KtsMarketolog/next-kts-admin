"use client";

import React, { useRef, useEffect, useState } from 'react';
import styles from './PromotionsBlock.module.scss';
import { ArrowCircleRightIcon } from '@/shared/icons/ArrowCircleRightIcon';

const promos = [ {}, {}, {}, {}, {}, ];

export const PromotionsBlock = () => {

  const gridRef = useRef( null );
  const [ scrolled, setScrolled ] = useState( false );
  const [ scrollDirection, setScrollDirection ] = useState('right');

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
    const scrollAmount = 200;

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

    <section className ={ styles.promotionsBlock } id="sales">

      <div className = { styles.title }>

        АКЦИИ

        <div

          className = { styles.titleArrow }
          onClick = { scrollGrid}
          style = { {
            transform:
              scrollDirection === "left"
                ? "rotate(180deg)"
                : "rotate(0deg)",
            transition: "transform 0.3s ease",

          } }

        >

          <ArrowCircleRightIcon />
          
        </div>

      </div>

      <div

        className = { `${styles.grid} ${scrolled ? styles.scrolled : ''}` }
        ref = { gridRef }
        
      >
        { promos.map(( promo, idx ) => (

          <div key = { idx} className = { styles.card }>

            <div className = { styles.cardContent }>

              <div className = { styles.cardTitle }>{ promo.title }</div>

              <div className = {styles.cardSubtitle }>{ promo.subtitle }</div>

            </div>

          </div>

        ))}

      </div>

    </section>

  );

};