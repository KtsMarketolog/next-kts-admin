'use client';

import { Dispatch, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { News } from '@/features/admin/types';
import { AdminImagePicker } from '@/features/admin/shared/AdminImagePicker';
import { AdminOrderList } from '@/features/admin/shared/AdminOrderList';

type AdminNewsSectionProps = {
  news: News[];
  newsDraft: Omit<News, 'id'>;
  nextNewsOrder: number;
  draggedNewsId: number | null;
  busy: boolean;
  newsCreated: boolean;
  savedNewsId: number | null;
  setNewsDraft: Dispatch<SetStateAction<Omit<News, 'id'>>>;
  setDraggedNewsId: (id: number | null) => void;
  updateNews: (id: number, patch: Partial<News>) => void;
  moveNews: (draggedId: number, targetId: number) => Promise<void>;
  createNews: () => Promise<void>;
  saveNews: (item: News) => Promise<void>;
  deleteNews: (id: number) => Promise<void>;
  uploadImage: (file: File) => Promise<string>;
  showStatus: (message: string) => void;
};

export function AdminNewsSection({
  news,
  newsDraft,
  nextNewsOrder,
  draggedNewsId,
  busy,
  newsCreated,
  savedNewsId,
  setNewsDraft,
  setDraggedNewsId,
  updateNews,
  moveNews,
  createNews,
  saveNews,
  deleteNews,
  uploadImage,
  showStatus,
}: AdminNewsSectionProps) {
  const uploadNewsImage = async (file: File, onUploaded: (url: string) => void) => {
    try {
      const url = await uploadImage(file);
      onUploaded(url);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : 'Ошибка загрузки');
    }
  };

  return (
    <section className={styles.section}>
      <h2>Новости</h2>

      <AdminOrderList
        items={news}
        draggedId={draggedNewsId}
        busy={busy}
        ariaLabel="Очередность новостей"
        dragTitle="Перетащите новость"
        onDragStart={setDraggedNewsId}
        onDrop={(targetId) => {
          if (!draggedNewsId || draggedNewsId === targetId) {
            setDraggedNewsId(null);
            return;
          }
          void moveNews(draggedNewsId, targetId);
          setDraggedNewsId(null);
        }}
        onDragEnd={() => setDraggedNewsId(null)}
        renderThumb={(item, index) => (item.imageUrl ? <img src={item.imageUrl} alt="" /> : <span>{index + 1}</span>)}
      />

      <div className={styles.newsCard}>
        <AdminImagePicker
          imageUrl={newsDraft.imageUrl}
          onUpload={(file) =>
            uploadNewsImage(file, (url) => setNewsDraft((current) => ({ ...current, imageUrl: url })))
          }
        />
        <div className={styles.newsFields}>
          <input
            value={newsDraft.date}
            onChange={(event) => setNewsDraft({ ...newsDraft, date: event.target.value })}
            placeholder="Дата, например Ноябрь - 2025"
          />
          <textarea
            className={styles.titleTextarea}
            value={newsDraft.title}
            onChange={(event) => setNewsDraft({ ...newsDraft, title: event.target.value })}
            placeholder="Заголовок новости"
            rows={2}
          />
          <input
            value={newsDraft.linkUrl}
            onChange={(event) => setNewsDraft({ ...newsDraft, linkUrl: event.target.value })}
            placeholder="Ссылка при клике"
          />
          <input type="number" value={nextNewsOrder} readOnly placeholder="Позиция" />
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={newsDraft.isActive}
              onChange={(event) => setNewsDraft({ ...newsDraft, isActive: event.target.checked })}
            />
            Показывать
          </label>
          <button
            className={`${styles.compactButton} ${newsCreated ? styles.savedButton : ''}`}
            disabled={busy}
            onClick={createNews}
          >
            {newsCreated ? 'Новость добавлена' : 'Добавить новость'}
          </button>
        </div>
      </div>

      <div className={styles.newsList}>
        {news.map((item) => (
          <article className={styles.newsCard} key={item.id}>
            <AdminImagePicker
              imageUrl={item.imageUrl}
              onUpload={(file) => uploadNewsImage(file, (url) => updateNews(item.id, { imageUrl: url }))}
            />
            <div className={styles.newsFields}>
              <input value={item.date} onChange={(event) => updateNews(item.id, { date: event.target.value })} placeholder="Дата" />
              <textarea
                className={styles.titleTextarea}
                value={item.title}
                onChange={(event) => updateNews(item.id, { title: event.target.value })}
                placeholder="Заголовок новости"
                rows={2}
              />
              <input
                value={item.linkUrl}
                onChange={(event) => updateNews(item.id, { linkUrl: event.target.value })}
                placeholder="Ссылка при клике"
              />
              <input type="number" value={item.sortOrder} readOnly placeholder="Позиция" />
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={item.isActive}
                  onChange={(event) => updateNews(item.id, { isActive: event.target.checked })}
                />
                Показывать
              </label>
              <div className={styles.actions}>
                <button
                  className={savedNewsId === item.id ? styles.savedButton : undefined}
                  disabled={busy}
                  onClick={() => saveNews(item)}
                >
                  {savedNewsId === item.id ? 'Сохранено' : 'Сохранить'}
                </button>
                <button className={styles.danger} disabled={busy} onClick={() => deleteNews(item.id)}>
                  Удалить
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
