export type BrandCategory = {
  id: number;
  key: string;
  title: string;
  sortOrder: number;
  isActive: boolean;
};

export type BrandItem = {
  id: number;
  categoryId: number;
  name: string;
  imageUrl: string;
  iconKey: string;
  sortOrder: number;
  isActive: boolean;
};

export type BrandCategorySeed = Omit<BrandCategory, 'id'>;
export type BrandItemSeed = Omit<BrandItem, 'id' | 'categoryId'> & { categoryKey: string };

export const DEFAULT_BRAND_CATEGORIES: BrandCategorySeed[] = [
  { key: 'compressors', title: 'Компрессоры', sortOrder: 1, isActive: true },
  { key: 'heatexchange', title: 'Теплообменное оборудование', sortOrder: 2, isActive: true },
  { key: 'fans', title: 'Вентиляторы и микродвигатели', sortOrder: 3, isActive: true },
  { key: 'controllers', title: 'Контроллеры', sortOrder: 4, isActive: true },
  { key: 'pipes', title: 'Медные трубы', sortOrder: 5, isActive: true },
  { key: 'vessels', title: 'Сосуды давления', sortOrder: 6, isActive: true },
  { key: 'line', title: 'Линейная автоматика', sortOrder: 7, isActive: true },
  { key: 'heating', title: 'Нагревательные элементы', sortOrder: 8, isActive: true },
];

export const DEFAULT_BRAND_ITEMS: BrandItemSeed[] = [
  { categoryKey: 'compressors', name: 'Tecumseh', iconKey: 'tecumseh', imageUrl: '', sortOrder: 1, isActive: true },
  { categoryKey: 'compressors', name: 'Cubigel compressors', iconKey: 'cubigel', imageUrl: '', sortOrder: 2, isActive: true },
  { categoryKey: 'compressors', name: 'Secop', iconKey: 'secop', imageUrl: '', sortOrder: 3, isActive: true },
  { categoryKey: 'compressors', name: 'Invotech', iconKey: 'invotech', imageUrl: '', sortOrder: 4, isActive: true },
  { categoryKey: 'compressors', name: 'Weishans', iconKey: 'weishans', imageUrl: '', sortOrder: 5, isActive: true },
  { categoryKey: 'compressors', name: 'Wansheng', iconKey: 'wansheng', imageUrl: '', sortOrder: 6, isActive: true },
  { categoryKey: 'compressors', name: 'Bitzer', iconKey: 'bitzer', imageUrl: '', sortOrder: 7, isActive: true },
  { categoryKey: 'compressors', name: 'RefComp', iconKey: 'refcomp', imageUrl: '', sortOrder: 8, isActive: true },
  { categoryKey: 'compressors', name: 'Frascold', iconKey: 'frascold', imageUrl: '', sortOrder: 9, isActive: true },
  { categoryKey: 'heatexchange', name: 'Hispania', iconKey: 'hispania', imageUrl: '', sortOrder: 1, isActive: true },
  { categoryKey: 'heatexchange', name: 'Lamel', iconKey: 'lamel', imageUrl: '', sortOrder: 2, isActive: true },
  { categoryKey: 'heatexchange', name: 'Intercold', iconKey: 'intercold', imageUrl: '', sortOrder: 3, isActive: true },
  { categoryKey: 'heatexchange', name: 'Onda', iconKey: 'onda', imageUrl: '', sortOrder: 4, isActive: true },
  { categoryKey: 'heatexchange', name: 'Guntner', iconKey: 'guntner', imageUrl: '', sortOrder: 5, isActive: true },
  { categoryKey: 'fans', name: 'Maer Fan Motor', iconKey: 'maerFanMotor', imageUrl: '', sortOrder: 1, isActive: true },
  { categoryKey: 'fans', name: 'FansTech', iconKey: 'fansTech', imageUrl: '', sortOrder: 2, isActive: true },
  { categoryKey: 'fans', name: 'Dunli', iconKey: 'dunli', imageUrl: '', sortOrder: 3, isActive: true },
  { categoryKey: 'fans', name: 'Weiguang', iconKey: 'weiguang', imageUrl: '', sortOrder: 4, isActive: true },
  { categoryKey: 'fans', name: 'Afl', iconKey: 'afl', imageUrl: '', sortOrder: 5, isActive: true },
  { categoryKey: 'fans', name: 'Bayoung', iconKey: 'bayoung', imageUrl: '', sortOrder: 6, isActive: true },
  { categoryKey: 'fans', name: 'Sunon', iconKey: 'sunon', imageUrl: '', sortOrder: 7, isActive: true },
  { categoryKey: 'controllers', name: 'Carel', iconKey: 'carel', imageUrl: '', sortOrder: 1, isActive: true },
  { categoryKey: 'controllers', name: 'Dixell', iconKey: 'dixell', imageUrl: '', sortOrder: 2, isActive: true },
  { categoryKey: 'controllers', name: 'Elitech', iconKey: 'elitech', imageUrl: '', sortOrder: 3, isActive: true },
  { categoryKey: 'controllers', name: 'Shtrol', iconKey: 'shtrol', imageUrl: '', sortOrder: 4, isActive: true },
  { categoryKey: 'pipes', name: 'Icg', iconKey: 'icg', imageUrl: '', sortOrder: 1, isActive: true },
  { categoryKey: 'pipes', name: 'Gt', iconKey: 'gt', imageUrl: '', sortOrder: 2, isActive: true },
  { categoryKey: 'pipes', name: 'Hailiang', iconKey: 'hailiang', imageUrl: '', sortOrder: 3, isActive: true },
  { categoryKey: 'vessels', name: 'Frigopoint', iconKey: 'frigopoint', imageUrl: '', sortOrder: 1, isActive: true },
  { categoryKey: 'line', name: 'Sanhua', iconKey: 'sanhua', imageUrl: '', sortOrder: 1, isActive: true },
  { categoryKey: 'line', name: 'Frigopoint', iconKey: 'frigopoint', imageUrl: '', sortOrder: 2, isActive: true },
  { categoryKey: 'line', name: 'Lefoo', iconKey: 'lefoo', imageUrl: '', sortOrder: 3, isActive: true },
  { categoryKey: 'heating', name: 'Sedes Group', iconKey: 'sedesGroup', imageUrl: '', sortOrder: 1, isActive: true },
  { categoryKey: 'heating', name: 'Heatgene', iconKey: 'heatgene', imageUrl: '', sortOrder: 2, isActive: true },
];
