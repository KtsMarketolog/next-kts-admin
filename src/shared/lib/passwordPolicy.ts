export type PasswordPolicyResult = {
  ok: boolean;
  error?: string;
};

export function validatePasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < 10) {
    return { ok: false, error: 'Password must be at least 10 characters' };
  }
  if (password.length > 200) {
    return { ok: false, error: 'Password must be 10-200 characters' };
  }
  if (!/[A-Za-zА-Яа-я]/.test(password) || !/\d/.test(password)) {
    return { ok: false, error: 'Password must include letters and digits' };
  }
  const simple = password.toLowerCase();
  if (['password', 'qwerty', '123456', 'admin', 'kts'].some((part) => simple.includes(part))) {
    return { ok: false, error: 'Password is too simple' };
  }
  return { ok: true };
}
