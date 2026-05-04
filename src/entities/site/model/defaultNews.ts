export type NewsItem = {
  id?: number;
  date: string;
  title: string;
  imageUrl: string;
  linkUrl: string;
  sortOrder: number;
  isActive: boolean;
};

export const DEFAULT_NEWS: NewsItem[] = [
  {
    date: 'Ноябрь - 2025',
    title: 'РУКОВОДСТВО WEISHANS И WEIGUANG ПОСЕТИЛИ КОМПАНИЮ KTC',
    imageUrl: '/img/news-img/news7.jpg',
    linkUrl: 'https://t.me/ktc_kazan/284',
    sortOrder: 1,
    isActive: true,
  },
  {
    date: 'Ноябрь - 2025',
    title: 'СОВЕТЫ ЛОГИСТА:\nЧТО ПОКУПАЕМ В НОЯБРЕ',
    imageUrl: '/img/news-img/news8.jpg',
    linkUrl: 'https://t.me/ktc_kazan/283',
    sortOrder: 2,
    isActive: true,
  },
  {
    date: 'Ноябрь - 2025',
    title: 'КОМАНДА KTC\nНА ВЫСТАВКЕ ПИР-2025',
    imageUrl: '/img/news-img/news9.jpg',
    linkUrl: 'https://t.me/ktc_kazan/256',
    sortOrder: 3,
    isActive: true,
  },
  {
    date: 'Сентябрь - 2025',
    title: 'НОВОЕ ПОСТУПЛЕНИЕ НА СКЛАДЕ KTC',
    imageUrl: '/img/news-img/news5.jpg',
    linkUrl: 'https://t.me/ktc_kazan/191',
    sortOrder: 4,
    isActive: true,
  },
  {
    date: 'Август - 2025',
    title: 'ХИТЫ ПРОДАЖ ПО ИТОГАМ АВГУСТА',
    imageUrl: '/img/news-img/news6.jpg',
    linkUrl: 'https://t.me/ktc_kazan/188',
    sortOrder: 5,
    isActive: true,
  },
  {
    date: 'Июль - 2025',
    title: 'KTC И INVOTECH: КУРС НА РАЗВИТИЕ И ЛИДЕРСТВО',
    imageUrl: '/img/news-img/news1.jpg',
    linkUrl: 'https://t.me/ktc_kazan/168',
    sortOrder: 6,
    isActive: true,
  },
  {
    date: 'Август - 2025',
    title: 'БОЛЬШИЕ БРЕНДЫ, СКИДКИ,\nСКЛАДЫ',
    imageUrl: '/img/news-img/news4.jpg',
    linkUrl: 'https://t.me/ktc_kazan/170',
    sortOrder: 7,
    isActive: true,
  },
  {
    date: 'Июль - 2025',
    title: 'СЕРЬЕЗНОЕ УСИЛЕНИЕ: БОЛЬШОЕ ПОСТУПЛЕНИЕ REFCOMP',
    imageUrl: '/img/news-img/news2.jpg',
    linkUrl: 'https://t.me/ktc_kazan/166',
    sortOrder: 8,
    isActive: true,
  },
  {
    date: 'Июль - 2025',
    title: 'ПРИМЕНЕНИЕ КОМПРЕССОРОВ WEISHANS ОДОБРЕНО СЕТЯМИ МАГНИТ И ПЯТЕРОЧКА',
    imageUrl: '/img/news-img/news3.jpg',
    linkUrl: 'https://t.me/ktc_kazan/155',
    sortOrder: 9,
    isActive: true,
  },
];
