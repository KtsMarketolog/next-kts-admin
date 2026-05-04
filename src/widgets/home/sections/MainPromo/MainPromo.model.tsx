import React from "react";

import styles from "./MainPromo.module.scss";
export type Viewport = "mobile" | "tablet" | "desktop";

export interface SlideButton {
  text: string;
  variant: "primary" | "purple";
  withBg?: boolean;
  href?: string;
}

export interface SlideAction {
  button: SlideButton;
  positionClass: string;
  showOn?: "all" | "mobile" | "tablet" | "desktop";
}

export interface SlidePopup {
  ariaLabel?: string;
  scrollContent?: boolean;
  content: React.ReactNode;
}

export interface Slide {
  id: string;
  bg: string;
  tabletBg: string;
  mobileBg: string;
  className: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  buttons: SlideButton[];
  extraSvg?: string;
  extraSvgTablet?: string;
  popup?: SlidePopup;
  actions?: SlideAction[];
  href?: string;
}

export const fallbackSlides: Slide[] = [
    {
    id: "slide5",
    bg: "/img/banner/slide5.jpg",
    tabletBg: "/img/banner/slide-tablet5.jpg",
    mobileBg: "/img/banner/slide-mobile5.jpg",
    className: styles.slideFour,
    title: <></>,
    subtitle: <></>,
    buttons: [],
    popup: {
      ariaLabel: "Информация",
      scrollContent: true,
      content: (
        <article className={styles.promoArticle} lang="ru">
          <picture>
            <source
              media="(max-width: 450px)"
              srcSet="/img/banner/popup-slide-mobile5.jpg"
            />
            <source
              media="(max-width: 1024px)"
              srcSet="/img/banner/popup-slide5.jpg"
            />
            <img
              src="/img/banner/popup-slide5.jpg"
              alt="Fans-Tech EC AF860"
              className={styles.promoImage}
              loading="lazy"
              decoding="async"
            />
          </picture>

          <div className={styles.promoBody}>
            <h3 className={styles.titleSlide6}>В наличии поршневые компрессоры Ankang</h3>
            <p className={styles.subtitleSlide6}>
              Преимущества компрессоров Ankang (Китай)
              {/* &emsp; */}
            </p>
            <br />
            <ul className={styles.customList}>
              <li>модельный ряд с объемом цилиндра от 26 до 145 см3 для низко- и среднетемпературного применения</li>
              <br />
              <li>на 30% дешевле европейских аналогов</li>
              <br />
              <li>прошел испытания и активно применяется на крупных холодильных производственных площадках</li>
              <br />
              <li>доступен к заказу и в наличии на складах КТС в России</li>
            </ul>
            <br />
          </div>
          
        </article>
      ),
    },
  },
  
  {
    id: "slide7",
    bg: "/img/banner/slide7.jpg",
    tabletBg: "/img/banner/slide-tablet7.jpg",
    mobileBg: "/img/banner/slide-mobile7.jpg",
    className: styles.slideFour,
    title: <></>,
    subtitle: <></>,
    buttons: [],
     href: "/klimatika",
  },

  {
    id: "slide4",
    bg: "/img/banner/slide4.jpg",
    tabletBg: "/img/banner/slide-tablet4.jpg",
    mobileBg: "/img/banner/slide-mobile4.jpg",
    className: styles.slideFour,
    title: <></>,
    subtitle: <></>,
    buttons: [],
    actions: [
      // пример:
      // {
      //   button: { text: "Подробнее >", variant: "primary", withBg: true },
      //   positionClass: styles.actionPosMobileCenter,
      //   showOn: "mobile",
      // },
    ],
    popup: {
      ariaLabel: "Информация",
      scrollContent: true,
      content: (
        <article className={styles.promoArticle} lang="ru">
          <picture>
            <source
              media="(max-width: 450px)"
              srcSet="/img/banner/popup-slide-mobile4.jpg"
            />
            <source
              media="(max-width: 1024px)"
              srcSet="/img/banner/popup-slide-tablet4.jpg"
            />
            <img
              src="/img/banner/popup-slide4.jpg"
              alt="Август — время больших сделок"
              className={styles.promoImage}
              loading="lazy"
              decoding="async"
            />
          </picture>

          <div className={`${styles.promoBody} ${styles.promoBodySlideMod4}`}>
            <h3>Важное по поставкам на 2026 (Q1–Q2)</h3>
            <p>
              Мы сохраняем портфель ключевых европейских брендов и продолжаем
              работу по регулярным <br /> поставкам в 2026 году. <br />
              При этом фиксируем рыночную реальность: сроки поставки
              увеличиваются (логистика, <br /> производственные слоты, очереди у
              фабрик). <br />
              Чтобы вы спокойно прошли сезон и не столкнулись с дефицитом,
              сейчас — лучший <br /> момент согласовать планы.
              <br />
              ✅ Что просим сделать:
              <br />
              обсудите со своим менеджером прогноз и объёмы на 1 и 2 квартал 2026
              года (Q1–Q2): <br />
              •приоритетные бренды/линейки <br />
              •ориентиры по объёмам и графику <br />
              •возможные альтернативы по позициям с длинным сроком <br />
              ! Что сделаем мы: <br />
              под ваши планы подготовим комплексное “под ключ” предложение:{" "}
              <br />
              •оптимальный график отгрузок <br />
              •варианты по срокам/партиям <br />
              •консолидированные поставки <br />
              •предложения по замене/аналогам там, где это уместно <br />
              <br />
              Свяжитесь с Вашим персональным менеджером ❄️КТС уже сегодня <br />
            </p>
          </div>
        </article>
      ),
    },
  },

  {
    id: "slide6",
    bg: "/img/banner/slide6.jpg",
    tabletBg: "/img/banner/slide-tablet6.jpg",
    mobileBg: "/img/banner/slide-mobile6.jpg",
    className: styles.slideFour,
    title: <></>,
    subtitle: <></>,
    buttons: [],
    popup: {
      ariaLabel: "Информация",
      scrollContent: true,
      content: (
        <article className={styles.promoArticle} lang="ru">
          <picture>
            <source
              media="(max-width: 450px)"
              srcSet="/img/banner/popup-slide-mobile6.jpg"
            />
            <source
              media="(max-width: 1024px)"
              srcSet="/img/banner/popup-slide-tablet6.jpg"
            />
            <img
              src="/img/banner/popup-slide6.jpg"
              alt="Сильный склад — сильные условия"
              className={styles.promoImage}
              loading="lazy"
              decoding="async"
            />
          </picture>

          <div className={`${styles.promoBody} ${styles.promoBodySlideMod6}`}>
            <h3>Важное обновление ассортимента КТС</h3>

            <p>
              Мы добавили техническую теплоизоляцию K-FLEX для инженерных систем и
              холодильного <br /> оборудования. <br />
              Что теперь можно закрыть “под ключ”: <br />
              <strong> Трубная теплоизоляция </strong> из вспененного каучука для
              всасывающих и других трубопроводов. <br />
              <strong> Листовая теплоизоляция </strong> — на клеевой основе и без
              неё — для обклейки резервуаров, <br /> аппаратов, воздуховодов и
              корпусов агрегатов. <br />
              <strong> Вспомогательные материалы для монтажа: </strong> клейкие
              ленты, полимерный клей, инструменты. <br />
              Всё из одной системы, рассчитано на совместную работу. <br />
              <strong> Пожарная безопасность и документация </strong> <br />
              Вся основная линейка выполнена из вспененного каучука, не
              поддерживающего горение. <br />
              По материалам доступен полный комплект сертификатов соответствия,
              которые можно сразу <br />
              включать в исполнительную документацию.
              <br />
              <strong> Соответствие требованиям федеральных сетей </strong> <br />
              Материалы K-FLEX уже прописаны в технических заданиях ряда
              крупнейших федеральных <br /> заказчиков. <br />
              Это снижает риски на этапе приёмо-сдаточных работ: марка утеплителя
              и его характеристики <br /> заранее согласованы.
              <br />
              <strong> Решения для разных уровней бюджета </strong> <br />
              Для объектов с ограничённым бюджетом и без повышенных требований по
              пожарной <br /> безопасности мы предлагаем теплоизоляцию из
              вспененного полиэтилена — рациональный <br /> вариант для типовых
              задач.
              <br />
              <strong> Снижение шума оборудования </strong> <br />
              При наличии жёстких требований по уровню шума доступен широкий
              ассортимент <br /> шумопоглощающих и шумоотражающих материалов. Это
              позволяет адаптировать агрегаты под <br /> конкретные условия
              установки и требования по дБ. <br />
              <strong> Что даёт работа с КТС </strong> <br />
              Помимо самой теплоизоляции вы получаете: <br />
              <strong> технические консультации </strong> по выбору толщины и
              типа материала; <br />
              <strong> помощь в подборе решений </strong> под конкретное ТЗ;{" "}
              <br />
              <strong> отгрузку со склада и выстроенную логистику </strong> по
              всей стране. <br />
              Если нужен подбор теплоизоляции под объект или техзадание заказчика
              — наши специалисты <br /> готовы подключиться и предложить
              оптимальное решение.
            </p>
          </div>
        </article>
      ),
    },
  },

  {
    id: "slide2",
    bg: "/img/banner/slide2.png",
    tabletBg: "/img/banner/slide-tablet2.png",
    mobileBg: "/img/banner/slide-mobile2.png",
    className: styles.slideTwo,
    // extraSvg: "/img/banner/slide2-extra.svg",
    // extraSvgTablet: "/img/banner/slide2-extra-tablet.svg",
    // title: <></>,
    // subtitle: <></>,
    title: <>Telegram канал КТС</>,
    subtitle: <>Узнавайте первыми о новостях, акциях и поступлениях на склад</>,
    buttons: [
      {
        text: "Подписаться >",
        variant: "primary",
        withBg: true,
        href: "https://t.me/ktc_kazan",
      },
    ],
  },

];

export function mapManagedSlide(slide: {
  id: number | string;
  imageUrl: string;
  tabletImageUrl?: string | null;
  mobileImageUrl?: string | null;
  popupImageUrl?: string | null;
  popupTabletImageUrl?: string | null;
  popupMobileImageUrl?: string | null;
  popupTitle?: string | null;
  popupText?: string | null;
  linkUrl?: string | null;
}): Slide {
  const fallback = fallbackSlides.find((item) => item.bg === slide.imageUrl);
  const hasManagedPopup = Boolean(slide.popupImageUrl || slide.popupTabletImageUrl || slide.popupMobileImageUrl || slide.popupTitle || slide.popupText);

  return {
    ...(fallback ?? {
      className: styles.slideFour,
      title: <></>,
      subtitle: <></>,
      buttons: [],
    }),
    id: String(slide.id),
    bg: slide.imageUrl,
    tabletBg: slide.tabletImageUrl || slide.imageUrl,
    mobileBg: slide.mobileImageUrl || slide.tabletImageUrl || slide.imageUrl,
    href: slide.linkUrl || undefined,
    popup: hasManagedPopup
      ? {
          ariaLabel: "Информация",
          scrollContent: true,
          content: (
            <article className={styles.promoArticle} lang="ru">
              {(slide.popupImageUrl || slide.popupTabletImageUrl || slide.popupMobileImageUrl) && (
                <picture>
                  <source
                    media="(max-width: 450px)"
                    srcSet={slide.popupMobileImageUrl || slide.popupTabletImageUrl || slide.popupImageUrl || ''}
                  />
                  <source
                    media="(max-width: 1024px)"
                    srcSet={slide.popupTabletImageUrl || slide.popupImageUrl || ''}
                  />
                  <img
                    src={slide.popupImageUrl || slide.popupTabletImageUrl || slide.popupMobileImageUrl || ''}
                    alt=""
                    className={styles.promoImage}
                    loading="lazy"
                    decoding="async"
                  />
                </picture>
              )}

              <div className={styles.promoBody}>
                {slide.popupTitle && <h3>{slide.popupTitle}</h3>}
                {slide.popupText && (
                  <p>
                    {slide.popupText.split('\n').map((line, index) => (
                      <React.Fragment key={index}>
                        {line}
                        {index < slide.popupText!.split('\n').length - 1 && <br />}
                      </React.Fragment>
                    ))}
                  </p>
                )}
              </div>
            </article>
          ),
        }
      : fallback?.popup,
  };
}
