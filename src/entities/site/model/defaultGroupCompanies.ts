export type GroupCompany = {
  id?: number;
  imageUrl: string;
  linkUrl: string;
  sortOrder: number;
  isActive: boolean;
};

export const DEFAULT_GROUP_COMPANIES: GroupCompany[] = [
  { imageUrl: '/img/group-companies/roskholod.png', linkUrl: 'https://rosholod.org/', sortOrder: 1, isActive: true },
  { imageUrl: '/img/group-companies/project-solutions.png', linkUrl: 'https://intercold.ru/', sortOrder: 2, isActive: true },
  { imageUrl: '/img/group-companies/mir.png', linkUrl: 'https://mir-expo.events/', sortOrder: 3, isActive: true },
  { imageUrl: '/img/group-companies/intercold.png', linkUrl: 'https://intercold.ru/', sortOrder: 4, isActive: true },
  { imageUrl: '/img/group-companies/marlin.png', linkUrl: '', sortOrder: 5, isActive: true },
];
