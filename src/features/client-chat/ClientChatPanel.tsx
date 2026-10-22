'use client';

import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { startClientRealtimeSync } from '@/shared/lib/clientRealtimeSync';
import { mergeClientChatMessages } from '@/shared/lib/clientChatState';
import { useClientChatReadReceipts } from './useClientChatReadReceipts';
import { createChatRequestScope } from './chatRequestScope';

import styles from './ClientChatPanel.module.scss';

type ChatAuthorType = 'client' | 'employee';

type ChatMessage = {
  id: number;
  authorType: ChatAuthorType;
  authorName: string;
  body: string;
  createdAt: string;
  readByOther: boolean;
  readByViewer: boolean;
};

type ClientChatPanelProps = {
  endpoint: string;
  eventsEndpoint: string;
  currentAuthorType: ChatAuthorType;
  readOnly?: boolean;
  onUnreadCountChange?: (count: number) => void;
};

function formatMessageTime(value: string) {
  const date = new Date(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00').replace(/\.(\d{3})\d+/, '.$1'));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function readApiError(response: Response, fallback: string) {
  const data = await response.json().catch(() => null);
  return typeof data?.error === 'string' && data.error ? data.error : fallback;
}

export function ClientChatPanel({ endpoint, eventsEndpoint, currentAuthorType, onUnreadCountChange, readOnly = false }: ClientChatPanelProps) {
  // Never carry another company's messages, cursors, pending reads or typed text
  // through a route/permission change. Cleanup also aborts in-flight requests.
  return <ClientChatConversation key={`${endpoint}:${currentAuthorType}:${readOnly}`} {...{ endpoint, eventsEndpoint, currentAuthorType, onUnreadCountChange, readOnly }} />;
}

function ClientChatConversation({ endpoint, eventsEndpoint, currentAuthorType, onUnreadCountChange, readOnly = false }: ClientChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messageState = useRef<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [status, setStatus] = useState('');
  const [loadError, setLoadError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [newMessages, setNewMessages] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const olderCursor = useRef<number | null>(null);
  const newerCursor = useRef<number | null>(null);
  const initialized = useRef(false);
  const readEpoch = useRef(0);
  const pendingReads = useRef(0);
  const countSequence = useRef(0);
  const lastCountSequence = useRef(0);
  const receiptOffset = useRef(0);
  const mounted = useRef(true);
  const lifetime = useRef(new AbortController());
  const olderRequest = useRef<AbortController | null>(null);
  const liveRequest = useRef<ReturnType<typeof createChatRequestScope> | null>(null);
  const unreadCallback = useRef(onUnreadCountChange);
  const anchor = useRef<{ id: number; offset: number; scrollTop: number } | null>(null);
  const shouldScrollBottom = useRef(false);
  useEffect(() => { unreadCallback.current = onUnreadCountChange; }, [onUnreadCountChange]);

  useEffect(() => {
    mounted.current = true;
    // React Strict Mode may mount effects again without recreating refs.
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    return () => { mounted.current = false; lifetime.current.abort(); olderRequest.current?.abort(); };
  }, []);

  const nearBottom = useCallback(() => {
    const node = messagesRef.current;
    return !node || node.scrollHeight - node.clientHeight - node.scrollTop < 48;
  }, []);

  const replaceMessages = useCallback((incoming: ChatMessage[]) => {
    const merged = mergeClientChatMessages(messageState.current, incoming);
    messageState.current = merged;
    setMessages(merged);
  }, []);

  const scrollToBottom = useCallback(() => {
    setNewMessages(false);
    window.requestAnimationFrame(() => {
      if (!mounted.current) return;
      const node = messagesRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
  }, []);

  // Prepending history must not move the message being read. Use its DOM offset
  // rather than total height: a live reply can arrive at the same time below it.
  useLayoutEffect(() => {
    const node = messagesRef.current;
    if (!node) return;
    const previousAnchor = anchor.current;
    if (previousAnchor) {
      const element = node.querySelector<HTMLElement>(`[data-chat-message-id="${previousAnchor.id}"]`);
      node.scrollTop = element ? node.scrollTop + element.getBoundingClientRect().top - node.getBoundingClientRect().top - previousAnchor.offset : previousAnchor.scrollTop;
      anchor.current = null;
    } else if (shouldScrollBottom.current) {
      node.scrollTop = node.scrollHeight;
      shouldScrollBottom.current = false;
    }
  }, [messages]);

  const publishUnreadCount = useCallback((count: unknown, epoch: number, sequence: number) => {
    if (readEpoch.current !== epoch || pendingReads.current || sequence < lastCountSequence.current) return;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return;
    lastCountSequence.current = sequence;
    unreadCallback.current?.(count);
  }, []);

  const { readError, retryReads } = useClientChatReadReceipts({
    endpoint, currentAuthorType, readOnly, messages, container: messagesRef,
    onStart: () => { readEpoch.current += 1; pendingReads.current += 1; },
    onAcknowledged: (ids, count) => {
      if (!mounted.current) return;
      const acknowledged = new Set(ids);
      replaceMessages(messageState.current.filter((message) => acknowledged.has(message.id)).map((message) => ({ ...message, readByViewer: true })));
      unreadCallback.current?.(count);
    },
    onFinish: () => { pendingReads.current -= 1; readEpoch.current += 1; },
  });

  const loadMessages = useCallback(
    async (signal?: AbortSignal) => {
      if (liveRequest.current && !liveRequest.current.signal.aborted) return;
      const request = createChatRequestScope([lifetime.current.signal, signal], 10_000);
      liveRequest.current = request;
      try {
        const requestSignal = request.signal;
        let hasNewer = true;
        while (hasNewer && !requestSignal.aborted) {
          const requestedCursor = newerCursor.current;
          const query = new URLSearchParams();
          if (initialized.current) query.set('after', String(requestedCursor ?? 0));
          const pending = messageState.current.filter((message) => message.authorType === currentAuthorType && !message.readByOther);
          const offset = pending.length ? receiptOffset.current % pending.length : 0;
          const receiptIds = [...pending.slice(offset), ...pending.slice(0, offset)].slice(0, 100).map((message) => message.id);
          receiptOffset.current = offset + receiptIds.length;
          if (receiptIds.length) query.set('receiptIds', receiptIds.join(','));
          const epoch = readEpoch.current;
          const sequence = ++countSequence.current;
          const response = await fetch(`${endpoint}${query.size ? `?${query}` : ''}`, { cache: 'no-store', signal: requestSignal });
          if (!response.ok) throw new Error(await readApiError(response, 'Не удалось загрузить чат'));
          const data = await response.json();
          if (requestSignal.aborted || !mounted.current) return;
          if (!Array.isArray(data.messages)) throw new Error('Не удалось загрузить чат: некорректный ответ сервера');
          const isFirstPage = !initialized.current;
          const atBottom = nearBottom();
          const newIds = new Set(messageState.current.map((message) => message.id));
          const hasIncoming = data.messages.some((message: ChatMessage) => !newIds.has(message.id));
          const receiptSet = new Set<number>(Array.isArray(data.readMessageIds) ? data.readMessageIds : []);
          const receiptUpdates = messageState.current.filter((message) => message.authorType === currentAuthorType && receiptSet.has(message.id))
            .map((message) => ({ ...message, readByOther: true }));
          shouldScrollBottom.current = isFirstPage || (atBottom && hasIncoming);
          if (!isFirstPage && !atBottom && hasIncoming) setNewMessages(true);
          replaceMessages([...data.messages, ...receiptUpdates]);
          if (isFirstPage) {
            olderCursor.current = data.olderCursor ?? null;
            setHasOlder(data.hasOlder === true);
            initialized.current = true;
          }
          // Only GET advances this cursor. A sent message may have skipped many
          // concurrent incoming messages which still have to be fetched.
          if (data.newerCursor !== null && data.newerCursor !== undefined) newerCursor.current = data.newerCursor;
          hasNewer = data.hasNewer === true;
          if (hasNewer && (data.messages.length === 0 || newerCursor.current === requestedCursor)) {
            throw new Error('Не удалось продолжить загрузку чата. Повторите попытку.');
          }
          publishUnreadCount(data.unreadCount, epoch, sequence);
          setLoading(false);
          setLoadError('');
        }
      } finally {
        request.dispose();
        if (liveRequest.current === request) liveRequest.current = null;
      }
    },
    [endpoint, currentAuthorType, nearBottom, replaceMessages, publishUnreadCount],
  );

  useEffect(() => {
    return startClientRealtimeSync({
      eventsEndpoint,
      eventTypes: ['chat.updated'],
      refresh: loadMessages,
      onError: (error) => {
        setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить чат');
        setLoading(false);
      },
    });
  }, [eventsEndpoint, loadMessages]);

  const loadOlderMessages = async () => {
    if (olderRequest.current || olderCursor.current === null) return;
    const controller = new AbortController();
    const request = createChatRequestScope([controller.signal, lifetime.current.signal], 10_000);
    olderRequest.current = controller;
    setLoadingOlder(true);
    setHistoryError('');
    try {
      const epoch = readEpoch.current;
      const sequence = ++countSequence.current;
      const response = await fetch(`${endpoint}?before=${olderCursor.current}`, {
        cache: 'no-store', signal: request.signal,
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось загрузить предыдущие сообщения'));
      const data = await response.json();
      if (!mounted.current || request.signal.aborted) return;
      if (!Array.isArray(data.messages)) throw new Error('Не удалось загрузить предыдущие сообщения');
      const node = messagesRef.current;
      if (node) {
        const firstVisible = Array.from(node.querySelectorAll<HTMLElement>('[data-chat-message-id]'))
          .find((element) => element.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
        if (firstVisible) anchor.current = { id: Number(firstVisible.dataset.chatMessageId), offset: firstVisible.getBoundingClientRect().top - node.getBoundingClientRect().top, scrollTop: node.scrollTop };
      }
      shouldScrollBottom.current = false;
      replaceMessages(data.messages);
      olderCursor.current = data.olderCursor ?? null;
      setHasOlder(data.hasOlder === true);
      publishUnreadCount(data.unreadCount, epoch, sequence);
    } catch (error) {
      if (mounted.current) setHistoryError(error instanceof Error ? error.message : 'Не удалось загрузить предыдущие сообщения');
    } finally {
      request.dispose();
      olderRequest.current = null;
      if (mounted.current) setLoadingOlder(false);
    }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (readOnly || !message || sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    setStatus('');
    const request = createChatRequestScope([lifetime.current.signal], 15_000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: request.signal,
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось отправить сообщение'));
      const data = await response.json().catch(() => ({}));
      if (!mounted.current) return;
      if (data.message) {
        replaceMessages([data.message]);
      }
      setDraft((current) => current.trim() === message ? '' : current);
      scrollToBottom();
    } catch (error) {
      if (mounted.current) setStatus(error instanceof Error ? error.message : 'Не удалось отправить сообщение. Проверьте соединение.');
    } finally {
      request.dispose();
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  };

  return (
    <div className={styles.chat}>
      {hasOlder ? <div className={styles.historyControls}>
        <button type="button" disabled={loadingOlder} onClick={() => { void loadOlderMessages(); }}>
          {loadingOlder ? 'Загружаем историю...' : 'Загрузить предыдущие сообщения'}
        </button>
      </div> : null}
      {historyError ? <p role="status" className={styles.status}>{historyError}</p> : null}
      <div className={styles.messages} ref={messagesRef} data-testid="chat-messages" onScroll={() => { if (nearBottom()) setNewMessages(false); }}>
        {loading && messages.length === 0 ? (
          <div className={styles.empty}>
            <strong>Загружаем чат</strong>
            <span>Подождите несколько секунд.</span>
          </div>
        ) : messages.length === 0 ? (
          <div className={styles.empty}>
            <strong>Сообщений пока нет</strong>
            <span>{readOnly ? 'Переписка архивного клиента доступна только для просмотра.' : 'Напишите первое сообщение.'}</span>
          </div>
        ) : (
          messages.map((message) => (
            <article
              className={`${styles.message} ${message.authorType === currentAuthorType ? styles.messageOwn : ''}`}
              key={message.id}
              data-chat-message-id={message.id}
            >
              <div className={styles.messageMeta}>
                <span>{message.authorName || (message.authorType === 'client' ? 'Клиент' : 'Менеджер')}</span>
                <span className={styles.messageMetaRight}>
                  {message.authorType === currentAuthorType ? (
                    <span
                      className={styles.readStatus}
                      title={message.readByOther ? 'Прочитано' : 'Отправлено'}
                      aria-label={message.readByOther ? 'Прочитано' : 'Отправлено'}
                    >
                      {message.readByOther ? '✓✓' : '✓'}
                    </span>
                  ) : null}
                  <span>{formatMessageTime(message.createdAt)}</span>
                </span>
              </div>
              <p className={styles.messageBody}>{message.body}</p>
            </article>
          ))
        )}
      </div>
      {newMessages ? <button type="button" className={styles.newMessages} onClick={scrollToBottom}>К новым сообщениям ↓</button> : null}
      {loadError ? <div className={styles.historyControls}>
        <p role="status" className={styles.status}>{loadError}</p>
        <button type="button" onClick={() => { void loadMessages().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить чат')); }}>Повторить загрузку</button>
      </div> : null}
      {readError ? <div className={styles.historyControls}>
        <p role="status" className={styles.status}>{readError}</p>
        <button type="button" onClick={retryReads}>Повторить подтверждение прочтения</button>
      </div> : null}

      {!readOnly ? <form className={styles.composer} onSubmit={sendMessage}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="Введите сообщение"
        />
        <button disabled={sending || !draft.trim()}>{sending ? 'Отправляем...' : 'Отправить'}</button>
      </form> : <p className={styles.status}>Клиент в архиве. Отправка сообщений отключена.</p>}
      {status ? <p role="status" className={styles.status}>{status}</p> : null}
    </div>
  );
}
