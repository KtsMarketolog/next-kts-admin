export type ClientCompany = {
  id: number;
  title: string;
  email: string;
  phone: string;
  note: string;
  managerId: number | null;
  managerName: string;
  supportManagerId: number | null;
  supportManagerName: string;
  userCount: number;
  clientLogin: string;
  clientUserId: number | null;
  chatUnreadCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ClientTab = 'prices' | 'requests' | 'documents' | 'chat' | 'data';

export type AdminClientDetailSectionProps = {
  clientId: number;
  onBack: () => void;
};

export const tabs: Array<{ value: ClientTab; label: string; description: string }> = [
  { value: 'prices', label: 'Прайсы', description: 'Привязанные индивидуальные прайсы' },
  { value: 'requests', label: 'Заявки', description: 'Отправленные заявки клиента' },
  { value: 'documents', label: 'Документы', description: 'Файлы и материалы клиента' },
  { value: 'chat', label: 'Чат', description: 'Переписка с клиентом' },
  { value: 'data', label: 'Данные клиента', description: 'Контакты, менеджеры и доступ' },
];

const CLIENT_TAB_VALUES = new Set<ClientTab>(tabs.map((tab) => tab.value));
export function resolveClientTab(value: string | null): ClientTab {
  return value && CLIENT_TAB_VALUES.has(value as ClientTab) ? (value as ClientTab) : 'prices';
}
