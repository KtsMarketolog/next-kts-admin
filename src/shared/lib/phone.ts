export const DEFAULT_PHONE = '+7 964 860 90 10';
export const DEFAULT_EMAIL = 'info@kts-impex.ru';
export const DEFAULT_ADDRESS = 'Республика Марий Эл, г. Волжск, ул. Мамасево, д. 1';

export function phoneHref(phone: string) {
  const digits = phone.replace(/\D/g, '');
  return digits ? `tel:+${digits}` : '#';
}
