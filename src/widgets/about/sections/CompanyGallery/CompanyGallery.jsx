"use client";

import React, { useRef, useEffect, useState } from "react";
import styles from "./CompanyGallery.module.scss";

const images = [

  "/img/company/company1.jpg",
  "/img/company/company2.jpg",
  "/img/company/company3.jpg",
  "/img/company/company4.jpg",
  "/img/company/company5.jpg",

];

export const CompanyGallery = () => {

  const gridRef = useRef(null);
  const [ pageIndex, setPageIndex ] = useState(0);
  const [ isTablet, setIsTablet ] = useState( false );
  const [ isMobile, setIsMobile ] = useState(false);

  const [ isAtStart, setIsAtStart ] = useState( true );
  const isAtEnd = false;

  useEffect(() => {

    const handleResize = () => {

      setIsTablet(window.innerWidth <= 1024);
      setIsMobile(window.innerWidth <= 450);

    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);

  }, []);

  useEffect(() => {
    
    const grid = gridRef.current;
    if (!grid) return;

  const onScroll = () => {

    if (!isTablet) return;

    const { scrollLeft, scrollWidth, clientWidth } = grid;

    setIsAtStart(scrollLeft <= 2);

    const card = grid.querySelector(`.${styles.scrollCard}`);
    if (!card) return;
    const cardWidth = card.offsetWidth + 20;

    const totalCards = images.length - 1;
    const lastSlideTrigger = scrollWidth - clientWidth - cardWidth / 2;

    let newIndex;

    if (scrollLeft >= lastSlideTrigger) {
      
      newIndex = totalCards - 1;

    } else {
   
      newIndex = Math.floor(scrollLeft / cardWidth);

    }

    setPageIndex(newIndex);

  };


    grid.addEventListener("scroll", onScroll);
    return () => grid.removeEventListener("scroll", onScroll);

  }, [ isTablet, isMobile ]);

  const scrollToSlide = (idx) => {

    if (!gridRef.current) return;

    const card = gridRef.current.querySelector(`.${styles.scrollCard}`);
    if (!card) return;

    const cardWidth = card.offsetWidth + 20;
    gridRef.current.scrollTo({
      
      left: idx * cardWidth,
      behavior: "smooth",

    });

  };

  let clipClass = "";

  if (!isAtStart && !isAtEnd) {

    clipClass = styles.clipBoth; // середина

  } else if (!isAtStart && isAtEnd) {

    clipClass = styles.clipLeft; // убираем только слева

  } else if (isAtStart && !isAtEnd) {

    clipClass = styles.clipRight; // убираем только справа
  }

  return (

    <section className = { styles.companyGallery }>

      <div className = { styles.grid }>

        { isMobile ? (

          // --- Мобильный режим: ВСЕ картинки скроллятся (без big) ---
          <div className = { `${styles.scrollWrapper}` } ref = { gridRef }>

            { [

              "/img/company/companySmall1.jpg", // маленькая версия для мобилки
              ...images.slice(1),

            ].map((src, idx) => (

              <div key = { idx } className = { styles.scrollCard }>

                <img src = { src } alt = { `Фото ${idx + 1}` } />

              </div>

            )) }

          </div>

          ) : isTablet ? (

            // --- Планшет: первая большая (big) и остальные скроллятся ---
            <>

              <div className = { `${styles.card} ${styles.big}` }>

                <img src = { images[0] } alt="Фото 1" />

              </div>

              <div className = { `${styles.scrollWrapper} ${clipClass}` } ref = { gridRef }>

                { images.slice(1).map((src, idx) => (

                  <div key = { idx } className = { styles.scrollCard }>

                    <img src = { src } alt = { `Фото ${idx + 2}` } />

                  </div>

                )) }

              </div>

            </>

          ) : (

            // --- Десктоп: сетка ---
            <>

              <div className = { `${styles.card} ${styles.big}` }>

                <img src = { images[0] } alt = "Фото 1" />

              </div>

              <div className = { styles.card }>

                <img src = { images[1]} alt = "Фото 2" />

              </div>

              <div className = { styles.card }>

                <img src = { images[2] } alt = "Фото 3" />

              </div>

              <div className = { styles.card }>

                <img src = { images[3]} alt = "Фото 4" />

              </div>

              <div className = { styles.card }>

                <img src = { images[4] } alt = "Фото 5" />

              </div>

            </>

          )}

      </div>

      { isTablet && (

        <div className = { styles.pagination }>

          {images.slice(1).map((_, idx) => (

            <span

              key = { idx}
              className = { `${styles.dot} ${
                pageIndex === idx ? styles.active : ""
              }` }
              onClick = { () => scrollToSlide(idx) }

            />

          ))}

        </div>

      ) }

    </section>

  );

};
