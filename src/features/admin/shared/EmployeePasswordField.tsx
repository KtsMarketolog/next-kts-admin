'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { employeeRequest, readLegacyEmployeePasswordCandidates, removeLegacyEmployeePasswordCandidates } from './employeeRequest';

type Props = { endpoint: string; disabled?: boolean; resetKey?: unknown };

/** Only server-confirmed passwords enter this short-lived view; legacy copies are verification candidates. */
export function EmployeePasswordField({ endpoint, disabled = false, resetKey }: Props) {
  const [revealed, setRevealed] = useState<{ value: string; endpoint: string; resetKey: unknown } | null>(null);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Mask in the same render as edit/save/identity changes, before effects run.
  const password = !disabled && revealed?.endpoint === endpoint && revealed.resetKey === resetKey ? revealed.value : null;

  const hide = useCallback(() => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
    clearTimeout(expiry.current);
    setRevealed(null);
    setMessage('');
    setPending(false);
  }, []);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) hide(); };
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', onVisibility);
      generation.current += 1;
      request.current?.abort();
      clearTimeout(expiry.current);
    };
  }, [hide]);

  useLayoutEffect(() => { hide(); }, [disabled, endpoint, resetKey, hide]);

  const read = async (copy: boolean) => {
    if (disabled || request.current) return;
    hide();
    const current = generation.current;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      const candidates = readLegacyEmployeePasswordCandidates(endpoint);
      const values = [...new Set(candidates.map((entry) => entry.password))];
      let data: { password: string | null } = { password: null };
      // There are at most two historical copies for this exact account, never a bulk import.
      for (const candidate of values.length ? values : [undefined]) {
        data = await employeeRequest<{ password: string | null }>(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(candidate === undefined ? {} : { legacyPassword: candidate }), signal: controller.signal,
        });
        if (data.password !== null && typeof data.password !== 'string') throw new Error('Сервер не передал корректный ответ. Повторите запрос пароля.');
        if (typeof data.password === 'string' && data.password) {
          removeLegacyEmployeePasswordCandidates(candidates);
          break;
        }
        removeLegacyEmployeePasswordCandidates(candidates.filter((entry) => entry.password === candidate));
        if (current !== generation.current || controller.signal.aborted || document.hidden) return;
      }
      if (current !== generation.current || controller.signal.aborted || document.hidden) return;
      if (typeof data.password !== 'string' || !data.password) {
        setMessage('Текущий пароль сохранён только для проверки входа: показать его нельзя. При необходимости задайте новый пароль.');
        return;
      }
      if (copy) {
        if (!navigator.clipboard?.writeText) throw new Error('Копирование недоступно. Покажите пароль и скопируйте его вручную.');
        await navigator.clipboard.writeText(data.password);
        if (current === generation.current) setMessage('Текущий пароль скопирован');
      } else {
        setRevealed({ value: data.password, endpoint, resetKey });
        expiry.current = setTimeout(hide, 30_000);
      }
    } catch (error) {
      if (current === generation.current && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Не удалось получить пароль');
    } finally {
      if (current === generation.current) { request.current = null; setPending(false); }
    }
  };

  return <div onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) hide(); }}>
    <input aria-label="Текущий пароль" type={password === null ? 'password' : 'text'} readOnly autoComplete="off" value={password ?? '••••••••'} />
    <div>
      <button type="button" disabled={disabled || pending} onClick={() => void read(false)}>Показать пароль</button>{' '}
      <button type="button" disabled={disabled || pending} onClick={() => void read(true)}>Скопировать пароль</button>{' '}
      {password !== null && <button type="button" onClick={hide}>Скрыть</button>}
    </div>
    {pending && <small role="status">Получение текущего пароля…</small>}
    {message && <small role="status">{message}</small>}
  </div>;
}
