export type HeroSlide = {
  id: number;
  title: string;
  imageUrl: string;
  tabletImageUrl: string | null;
  mobileImageUrl: string | null;
  popupImageUrl: string | null;
  popupTabletImageUrl: string | null;
  popupMobileImageUrl: string | null;
  popupTitle: string | null;
  popupText: string | null;
  linkUrl: string | null;
  sortOrder: number;
  isActive: boolean;
};

export const DEFAULT_HERO_SLIDES: Array<Omit<HeroSlide, 'id'>> = [
  {
    title: 'Ankang compressors',
    imageUrl: '/img/banner/slide5.jpg',
    tabletImageUrl: '/img/banner/slide-tablet5.jpg',
    mobileImageUrl: '/img/banner/slide-mobile5.jpg',
    popupImageUrl: '/img/banner/popup-slide5.jpg',
    popupTabletImageUrl: '/img/banner/popup-slide5.jpg',
    popupMobileImageUrl: '/img/banner/popup-slide-mobile5.jpg',
    popupTitle: 'В наличии поршневые компрессоры Ankang',
    popupText: 'Преимущества компрессоров Ankang (Китай)\n\n- модельный ряд с объёмом цилиндра от 26 до 145 см3 для низко- и среднетемпературного применения\n- на 30% дешевле европейских аналогов\n- прошёл испытания и активно применяется на крупных холодильных производственных площадках\n- доступен к заказу и в наличии на складах КТС в России',
    linkUrl: null,
    sortOrder: 10,
    isActive: true,
  },
  { title: 'Klimatika', imageUrl: '/img/banner/slide7.jpg', tabletImageUrl: '/img/banner/slide-tablet7.jpg', mobileImageUrl: '/img/banner/slide-mobile7.jpg', popupImageUrl: null, popupTabletImageUrl: null, popupMobileImageUrl: null, popupTitle: null, popupText: null, linkUrl: '/klimatika', sortOrder: 20, isActive: true },
  {
    title: 'Supply update',
    imageUrl: '/img/banner/slide4.jpg',
    tabletImageUrl: '/img/banner/slide-tablet4.jpg',
    mobileImageUrl: '/img/banner/slide-mobile4.jpg',
    popupImageUrl: '/img/banner/popup-slide4.jpg',
    popupTabletImageUrl: '/img/banner/popup-slide-tablet4.jpg',
    popupMobileImageUrl: '/img/banner/popup-slide-mobile4.jpg',
    popupTitle: 'Важное по поставкам на 2026 (Q1-Q2)',
    popupText: 'Мы сохраняем портфель ключевых европейских брендов и продолжаем работу по регулярным поставкам в 2026 году.\nПри этом фиксируем рыночную реальность: сроки поставки увеличиваются из-за логистики, производственных слотов и очередей у фабрик.\n\nЧтобы вы спокойно прошли сезон и не столкнулись с дефицитом, сейчас лучший момент согласовать планы.\n\nЧто просим сделать:\nобсудите со своим менеджером прогноз и объёмы на 1 и 2 квартал 2026 года (Q1-Q2):\n- приоритетные бренды/линейки\n- ориентиры по объёмам и графику\n- возможные альтернативы по позициям с длинным сроком\n\nЧто сделаем мы:\nпод ваши планы подготовим комплексное предложение под ключ:\n- оптимальный график отгрузок\n- варианты по срокам/партиям\n- консолидированные поставки\n- предложения по замене/аналогам там, где это уместно\n\nСвяжитесь с Вашим персональным менеджером. КТС уже сегодня',
    linkUrl: null,
    sortOrder: 30,
    isActive: true,
  },
  {
    title: 'K-Flex',
    imageUrl: '/img/banner/slide6.jpg',
    tabletImageUrl: '/img/banner/slide-tablet6.jpg',
    mobileImageUrl: '/img/banner/slide-mobile6.jpg',
    popupImageUrl: '/img/banner/popup-slide6.jpg',
    popupTabletImageUrl: '/img/banner/popup-slide-tablet6.jpg',
    popupMobileImageUrl: '/img/banner/popup-slide-mobile6.jpg',
    popupTitle: 'Важное обновление ассортимента КТС',
    popupText: 'Мы добавили техническую теплоизоляцию K-FLEX для инженерных систем и холодильного оборудования.\n\nТеперь можно закрыть под ключ:\n- трубную теплоизоляцию из вспененного каучука для всасывающих и других трубопроводов\n- листовую теплоизоляцию для резервуаров, аппаратов, воздуховодов и корпусов агрегатов\n- вспомогательные материалы для монтажа: клейкие ленты, полимерный клей, инструменты\n\nМатериалы K-FLEX уже прописаны в технических заданиях ряда крупных федеральных заказчиков. Если нужен подбор теплоизоляции под объект или техзадание, специалисты КТС готовы подключиться и предложить оптимальное решение.',
    linkUrl: null,
    sortOrder: 40,
    isActive: true,
  },
  { title: 'Telegram', imageUrl: '/img/banner/slide2.png', tabletImageUrl: '/img/banner/slide-tablet2.png', mobileImageUrl: '/img/banner/slide-mobile2.png', popupImageUrl: null, popupTabletImageUrl: null, popupMobileImageUrl: null, popupTitle: null, popupText: null, linkUrl: 'https://t.me/ktc_kazan', sortOrder: 50, isActive: true },
];
