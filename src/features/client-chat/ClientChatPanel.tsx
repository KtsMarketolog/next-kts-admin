'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { startClientRealtimeSync } from '@/shared/lib/clientRealtimeSync';
import { mergeClientChatMessages } from '@/shared/lib/clientChatState';

import styles from './ClientChatPanel.module.scss';

type ChatAuthorType = 'client' | 'employee';

type ChatMessage = {
  id: number;
  authorType: ChatAuthorType;
  authorName: string;
  body: string;
  createdAt: string;
  readByOther: boolean;
};

type ClientChatPanelProps = {
  endpoint: string;
  eventsEndpoint: string;
  currentAuthorType: ChatAuthorType;
  onUnreadCountChange?: (count: number) => void;
};

function formatMessageTime(value: string) {
  const date = new Date(value);
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

export function ClientChatPanel({ endpoint, eventsEndpoint, currentAuthorType, onUnreadCountChange }: ClientChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [status, setStatus] = useState('');
  const [loadError, setLoadError] = useState('');
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      const node = messagesRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
  }, []);

  const loadMessages = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(endpoint, { cache: 'no-store', signal });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось загрузить чат'));
      const data = await response.json();
      if (signal?.aborted) return;
      setMessages((current) => mergeClientChatMessages(current, Array.isArray(data.messages) ? data.messages : []));
      onUnreadCountChange?.(Number(data.unreadCount ?? 0));
      setLoading(false);
      setLoadError('');
    },
    [endpoint, onUnreadCountChange],
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

  const latestMessageId = messages.at(-1)?.id;
  useEffect(() => {
    scrollToBottom();
  }, [latestMessageId, scrollToBottom]);

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    setStatus('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось отправить сообщение'));
      const data = await response.json().catch(() => ({}));
      if (data.message) {
        setMessages((current) => mergeClientChatMessages(current, [data.message]));
      } else {
        await loadMessages(AbortSignal.timeout(10_000)).catch(() => undefined);
      }
      setDraft((current) => current.trim() === message ? '' : current);
      scrollToBottom();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Не удалось отправить сообщение. Проверьте соединение.');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <div className={styles.chat}>
      <div className={styles.messages} ref={messagesRef}>
        {loading && messages.length === 0 ? (
          <div className={styles.empty}>
            <strong>Загружаем чат</strong>
            <span>Подождите несколько секунд.</span>
          </div>
        ) : messages.length === 0 ? (
          <div className={styles.empty}>
            <strong>Сообщений пока нет</strong>
            <span>Напишите первое сообщение.</span>
          </div>
        ) : (
          messages.map((message) => (
            <article
              className={`${styles.message} ${message.authorType === currentAuthorType ? styles.messageOwn : ''}`}
              key={message.id}
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

      <form className={styles.composer} onSubmit={sendMessage}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="Введите сообщение"
        />
        <button disabled={sending || !draft.trim()}>{sending ? 'Отправляем...' : 'Отправить'}</button>
      </form>
      {status || loadError ? <p className={styles.status}>{status || loadError}</p> : null}
    </div>
  );
}
