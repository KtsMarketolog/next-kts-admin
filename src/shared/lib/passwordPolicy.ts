export type PasswordPolicyResult = {
  ok: boolean;
  error?: string;
};

export function validatePasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < 10) {
    return { ok: false, error: 'Пароль должен быть не короче 10 символов. Добавьте символы и повторите сохранение.' };
  }
  if (password.length > 200) {
    return { ok: false, error: 'Пароль должен быть не длиннее 200 символов' };
  }
  if (!/[\p{L}]/u.test(password) || !/\d/.test(password)) {
    return { ok: false, error: 'Пароль должен содержать буквы и цифры. Добавьте букву и цифру, затем сохраните снова.' };
  }
  const simple = password.toLowerCase();
  if (['password', 'qwerty', '123456', 'admin', 'kts'].some((part) => simple.includes(part))) {
    return { ok: false, error: 'Пароль слишком простой. Используйте другой пароль и сохраните снова.' };
  }
  return { ok: true };
}
