'use client';

import { RefObject, useCallback, useEffect, useRef, useState } from 'react';

type ReadableMessage = { id: number; authorType: string; readByViewer: boolean };
type Options = {
  endpoint: string;
  currentAuthorType: string;
  readOnly: boolean;
  messages: ReadableMessage[];
  container: RefObject<HTMLDivElement | null>;
  onStart: () => void;
  onAcknowledged: (ids: number[], unreadCount: number) => void;
  onFinish: () => void;
};

const VISIBLE_DWELL_MS = 500;
const RETRY_DELAYS = [1_000, 3_000, 10_000];

/** Reads are explicit receipts for rendered, visible messages, never a clock or
 * a high-water mark: older, offscreen messages must remain unread. */
export function useClientChatReadReceipts(options: Options) {
  const { endpoint, currentAuthorType, readOnly, container } = options;
  const latest = useRef(options);
  const rescan = useRef<() => void>(() => {});
  const retryRef = useRef<() => void>(() => {});
  const [readError, setReadError] = useState('');

  useEffect(() => {
    latest.current = options;
  }, [options]);

  // Composer keystrokes refresh callbacks, but do not change message DOM.
  // Rebuilding all observers is needed only when rendered messages change.
  useEffect(() => { rescan.current(); }, [options.messages]);

  useEffect(() => {
    if (readOnly) return;
    const node = container.current;
    if (!node) return;
    let stopped = false;
    let sending = false;
    let failures = 0;
    let retryAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const candidates = new Map<number, number>();
    const confirmed = new Set<number>();
    const observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(() => scan(), { root: node, threshold: [0, 0.1, 1] }) : undefined;

    function visibleIds() {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return [];
      for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.visibility !== 'visible' || style.opacity === '0' || style.contentVisibility === 'hidden') return [];
      }
      const bounds = node!.getBoundingClientRect();
      const top = Math.max(0, bounds.top);
      const bottom = Math.min(window.innerHeight, bounds.bottom);
      const left = Math.max(0, bounds.left);
      const right = Math.min(window.innerWidth, bounds.right);
      if (bottom <= top || right <= left) return [];
      const unread = new Set(latest.current.messages.filter((message) =>
        message.authorType !== currentAuthorType && !message.readByViewer && !confirmed.has(message.id),
      ).map((message) => message.id));
      return Array.from(node!.querySelectorAll<HTMLElement>('[data-chat-message-id]')).flatMap((element) => {
        const id = Number(element.dataset.chatMessageId);
        if (!unread.has(id) || element.getClientRects().length === 0) return [];
        const style = getComputedStyle(element);
        if (style.visibility !== 'visible' || style.opacity === '0') return [];
        const rect = element.getBoundingClientRect();
        const height = Math.min(bottom, rect.bottom) - Math.max(top, rect.top);
        if (height < Math.min(30, rect.height) || Math.min(right, rect.right) <= Math.max(left, rect.left)) return [];
        // A fixed header/dialog can cover a geometrically intersecting message.
        const hit = document.elementFromPoint(
          (Math.max(left, rect.left) + Math.min(right, rect.right)) / 2,
          (Math.max(top, rect.top) + Math.min(bottom, rect.bottom)) / 2,
        );
        return hit && element.contains(hit) ? [id] : [];
      });
    }

    function scan() {
      if (stopped) return;
      clearTimeout(timer);
      const now = Date.now();
      const visible = new Set(visibleIds());
      for (const id of candidates.keys()) if (!visible.has(id)) candidates.delete(id);
      for (const id of visible) if (!candidates.has(id)) candidates.set(id, now);
      if (sending || failures > RETRY_DELAYS.length || candidates.size === 0) return;
      const firstEligible = Math.min(...candidates.values()) + VISIBLE_DWELL_MS;
      timer = setTimeout(() => { void flush(); }, Math.max(0, firstEligible - now, retryAt - now));
    }

    async function flush() {
      if (stopped || sending) return;
      const now = Date.now();
      const ids = visibleIds().filter((id) => now - (candidates.get(id) ?? now) >= VISIBLE_DWELL_MS).slice(0, 100);
      if (!ids.length) { scan(); return; }
      sending = true;
      request = new AbortController();
      const timeout = setTimeout(() => request?.abort(), 10_000);
      latest.current.onStart();
      try {
        const response = await fetch(`${endpoint}/read`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageIds: ids }), signal: request.signal,
        });
        if (!response.ok) throw new Error('Не удалось подтвердить прочтение. Сообщения не потеряны.');
        const result = await response.json();
        if (stopped) return;
        const allowed = new Set(ids);
        const acknowledged: number[] = Array.isArray(result.acknowledgedIds)
          ? result.acknowledgedIds.filter((id: unknown): id is number => typeof id === 'number' && allowed.has(id)) : [];
        if (!acknowledged.length || !Number.isSafeInteger(result.unreadCount) || result.unreadCount < 0) {
          throw new Error('Не удалось подтвердить прочтение. Повторите попытку.');
        }
        for (const id of acknowledged) { confirmed.add(id); candidates.delete(id); }
        failures = 0;
        retryAt = 0;
        setReadError('');
        latest.current.onAcknowledged(acknowledged, result.unreadCount);
      } catch (error) {
        if (!stopped) {
          failures += 1;
          retryAt = Date.now() + (RETRY_DELAYS[failures - 1] ?? 0);
          setReadError(error instanceof Error && error.name !== 'AbortError'
            ? error.message : 'Не удалось подтвердить прочтение. Проверьте соединение.');
        }
      } finally {
        clearTimeout(timeout);
        latest.current.onFinish();
        sending = false;
        if (!stopped) scan();
      }
    }

    function refresh() {
      observer?.disconnect();
      node!.querySelectorAll('[data-chat-message-id]').forEach((element) => observer?.observe(element));
      scan();
    }
    function retry() { failures = 0; retryAt = 0; scan(); }
    function visibility() { if (document.visibilityState === 'visible') retry(); else scan(); }
    rescan.current = refresh;
    retryRef.current = retry;
    node.addEventListener('scroll', scan, { passive: true });
    window.addEventListener('scroll', scan, { passive: true, capture: true });
    window.addEventListener('resize', scan);
    window.addEventListener('focus', retry);
    window.addEventListener('blur', scan);
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', visibility);
    refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
      observer?.disconnect();
      candidates.clear();
      rescan.current = () => {};
      retryRef.current = () => {};
      node.removeEventListener('scroll', scan);
      window.removeEventListener('scroll', scan, true);
      window.removeEventListener('resize', scan);
      window.removeEventListener('focus', retry);
      window.removeEventListener('blur', scan);
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [endpoint, currentAuthorType, readOnly, container]);

  const retryReads = useCallback(() => retryRef.current(), []);
  return { readError, retryReads };
}
