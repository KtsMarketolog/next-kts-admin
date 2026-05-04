export type GroupCompany = {
  id?: number;
  imageUrl: string;
  sortOrder: number;
  isActive: boolean;
};

export const DEFAULT_GROUP_COMPANIES: GroupCompany[] = [
  { imageUrl: '/img/group-companies/roskholod.png', sortOrder: 1, isActive: true },
  { imageUrl: '/img/group-companies/project-solutions.png', sortOrder: 2, isActive: true },
  { imageUrl: '/img/group-companies/mir.png', sortOrder: 3, isActive: true },
  { imageUrl: '/img/group-companies/intercold.png', sortOrder: 4, isActive: true },
  { imageUrl: '/img/group-companies/marlin.png', sortOrder: 5, isActive: true },
];
