// src/components/sections/AreasOfUse/AreasOfUse.tsx
import {
  UniversalGridCards,
  type UniversalCardItem,
} from '@/shared/ui/UniversalGridCards/UniversalGridCards';
import styles from './AreasOfUse.module.scss';

type SizeKey = 's3_240' | 's4_240' | 's5_240' | 's6_240' | 's3_220';

type RawItem = {
  title: string;
  text: string;
  size: SizeKey;

  bgImage?: string;
  bgImageTablet?: string;
  bgImageMobile?: string;

  bgPosition?: string;
};

const items: RawItem[] = [
  {
    title: 'ЖИЛЫЕ<br/>ПОМЕЩЕНИЯ',
    text: 'Обеспечение комфортного уровня влажности необходимо для хорошего самочувствия людей и домашних животных, а также для сохранности интерьера: деревянного паркета, картин, музыкальных инструментов и мебели',
    size: 's3_240',
    // bgImage: '/img/klimatika/app-areas/area1.png',
    // bgImageTablet: '/img/klimatika/app-areas/area1-tablet.png',
    // bgImageMobile: '/img/klimatika/app-areas/area1-mobile.png',
    bgPosition: 'right bottom',
  },
  {
    title: 'ОПЕРАЦИОННЫЕ И<br/>ПРОЦЕДУРНЫЕ КАБИНЕТЫ',
    text: 'Контроль влажности воздуха напрямую влияет на скорость восстановления пациентов и снижает риски осложнений',
    size: 's4_240',
    bgImage: '/img/klimatika/app-areas/area2.png',
    bgImageTablet: '/img/klimatika/app-areas/area2-tablet.png',
    bgImageMobile: '/img/klimatika/app-areas/area2-mobile.png',
    bgPosition: 'right bottom',
  },
  {
    title: 'ЛАБОРАТОРИИ И<br/>ЧИСТЫЕ ПОМЕЩЕНИЯ',
    text: 'Относительная влажность — критический параметр, влияющий на результаты работ. Её отклонение может привести к электростатическим разрядам, биологическому загрязнению, изменению скорости химических реакций и увеличению капиллярных сил',
    size: 's5_240',
    bgImage: '/img/klimatika/app-areas/area3.png',
    bgImageTablet: '/img/klimatika/app-areas/area3-tablet.png',
    bgImageMobile: '/img/klimatika/app-areas/area3-mobile.png',
    bgPosition: 'right bottom',
  },
  {
    title: 'УЧРЕЖДЕНИЯ КУЛЬТУРЫ<br/>(МУЗЕИ, АРХИВЫ, БИБЛИОТЕКИ)',
    text: 'Стабильный уровень влажности защищает предметы искусства и культурного наследия. Его нарушение ведет к растрескиванию красочного слоя картин, деформации деревянных изделий, антикварной мебели, музыкальных инструментов и повреждению книг',
    size: 's6_240',
    bgImage: '/img/klimatika/app-areas/area4.png',
    bgImageTablet: '/img/klimatika/app-areas/area4-tablet.png',
    bgImageMobile: '/img/klimatika/app-areas/area4-mobile.png',
    bgPosition: 'right bottom',
  },
  {
    title: 'АДМИНИСТРАТИВНЫЕ ПОМЕЩЕНИЯ<br/>(ОФИСЫ, КОЛЛ-ЦЕНТРЫ)',
    text: 'Оптимальная влажность важна для здоровья сотрудников: она предотвращает пересыхание слизистых оболочек, снижает риск респираторных заболеваний и передачу инфекций, что особенно критично в помещениях с высокой речевой нагрузкой',
    size: 's6_240',
    bgImage: '/img/klimatika/app-areas/area5.png',
    bgImageTablet: '/img/klimatika/app-areas/area5-tablet.png',
    bgImageMobile: '/img/klimatika/app-areas/area5-mobile.png',
    bgPosition: 'right bottom',
  },
  {
    title: 'ПРОИЗВОДСТВЕННЫЕ<br/>ПОМЕЩЕНИЯ',
    text: 'Для многих отраслей (полиграфия, фармацевтика, электроника) поддержание заданной влажности — ключевое технологическое требование. Это предотвращает накопление статического электричества (порча бумаги, сбой процессов), обеспечивает возможность выполнения специфических операций и сохраняет свойства материалов',
    size: 's3_220',
    // bgImage: '/img/klimatika/app-areas/area6.png',
    // bgImageTablet: '/img/klimatika/app-areas/area6-tablet.png',
    // bgImageMobile: '/img/klimatika/app-areas/area6-mobile.png',
    bgPosition: 'right bottom',
  },
  {
    title: 'МЕДИЦИНСКИЕ<br/>УЧРЕЖДЕНИЯ',
    text: 'Системы климат-контроля обеспечивают параметры воздуха, соответствующие строгим государственным стандартам для операционных, палат и диагностических зон',
    size: 's3_220',
    bgImage: '/img/klimatika/app-areas/area7.png',
    // bgImageTablet: '/img/klimatika/app-areas/area7-tablet.png',
    bgImageMobile: '/img/klimatika/app-areas/area7-mobile.png',
    bgPosition: 'right bottom',
  },
  {
    title: 'ЦЕНТРЫ ОБРАБОТКИ<br/>ДАННЫХ (ЦОД)',
    text: 'Оборудование поддерживает  уровень влажности для нейтрализации электростатических зарядов, которые представляют прямую угрозу серверному оборудованию и целостности данных',
    size: 's3_220',
    // bgImage: '/img/klimatika/app-areas/area8.png',
    // bgImageTablet: '/img/klimatika/app-areas/area8-tablet.png',
    // bgImageMobile: '/img/klimatika/app-areas/area8-mobile.png',
    bgPosition: 'right bottom',
  },
  {
    title: 'СКЛАДЫ И<br/>ЛОГИСТИЧЕСКИЕ КОМПЛЕКСЫ',
    text: 'Гарантирует сохранность широкого спектра товаров: от продовольствия до текстиля, электроники и других товаров, чувствительных к пересыханию или статическому электричеству',
    size: 's3_220',
    // bgImage: '/img/klimatika/app-areas/area9.png',
    bgImageTablet: '/img/klimatika/app-areas/area9-tablet.png',
    // bgImageMobile: '/img/klimatika/app-areas/area9-mobile.png',
    bgPosition: 'right bottom',
  },
];

const SIZE_TO_SPANS: Record<SizeKey, UniversalCardItem['spans']> = {
  s3_240: {
    desktop: { col: 3, minH: 240 },
    tablet: { col: 6, minH: 220 },
    mobile: { col: 6, minH: 180 },
  },
  s4_240: {
    desktop: { col: 4, minH: 240 },
    tablet: { col: 6, minH: 220 },
    mobile: { col: 6, minH: 180 },
  },
  s5_240: {
    desktop: { col: 5, minH: 240 },
    tablet: { col: 12, minH: 240 },
    mobile: { col: 12, minH: 200 },
  },
  s6_240: {
    desktop: { col: 6, minH: 240 },
    tablet: { col: 12, minH: 240 },
    mobile: { col: 12, minH: 200 },
  },
  s3_220: {
    desktop: { col: 3, minH: 220 },
    tablet: { col: 6, minH: 220 },
    mobile: { col: 6, minH: 180 },
  },
};

const normalizedItems: UniversalCardItem[] = items.map((it, idx) => ({
  id: `areas-${idx + 1}`,
  title: it.title,
  desc: it.text,

  bgImage: it.bgImage,
  bgImageTablet: it.bgImageTablet,
  bgImageMobile: it.bgImageMobile,

  bgPos: it.bgPosition ?? 'right bottom',
  bgSize: 'cover',
  spans: SIZE_TO_SPANS[it.size],
}));

export const AreasOfUse = () => {
  return (
    <section className={styles.areas}>
      <UniversalGridCards title="ОБЛАСТИ ПРИМЕНЕНИЯ" items={normalizedItems} />
    </section>
  );
};