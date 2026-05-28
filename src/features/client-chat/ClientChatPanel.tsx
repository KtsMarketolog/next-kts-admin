'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

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

export function ClientChatPanel({ endpoint, currentAuthorType, onUnreadCountChange }: ClientChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      const node = messagesRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
  }, []);

  const loadMessages = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось загрузить чат'));
      const data = await response.json();
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      onUnreadCountChange?.(Number(data.unreadCount ?? 0));
      if (!silent) setLoading(false);
      scrollToBottom();
    },
    [endpoint, onUnreadCountChange, scrollToBottom],
  );

  useEffect(() => {
    let cancelled = false;

    loadMessages()
      .catch((error) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : 'Не удалось загрузить чат');
          setLoading(false);
        }
      });

    const intervalId = window.setInterval(() => {
      loadMessages(true).catch(() => undefined);
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [loadMessages]);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;

    setSending(true);
    setStatus('');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    setSending(false);

    if (!response.ok) {
      setStatus(await readApiError(response, 'Не удалось отправить сообщение'));
      return;
    }

    const data = await response.json().catch(() => ({}));
    if (data.message) {
      setMessages((current) => [...current, data.message]);
    } else {
      await loadMessages(true).catch(() => undefined);
    }
    setDraft('');
    scrollToBottom();
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
      {status ? <p className={styles.status}>{status}</p> : null}
    </div>
  );
}
