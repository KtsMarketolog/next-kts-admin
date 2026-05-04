'use client';

import { Dispatch, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { Slide } from '@/features/admin/types';
import { AdminOrderList } from '@/features/admin/shared/AdminOrderList';
import { AdminResponsiveImages } from '@/features/admin/shared/AdminResponsiveImages';

type AdminSliderSectionProps = {
  slides: Slide[];
  draft: Omit<Slide, 'id'>;
  nextSlideOrder: number;
  draggedSlideId: number | null;
  busy: boolean;
  savedSlideId: number | null;
  setDraft: Dispatch<SetStateAction<Omit<Slide, 'id'>>>;
  setDraggedSlideId: (id: number | null) => void;
  updateSlide: (id: number, patch: Partial<Slide>) => void;
  moveSlide: (draggedId: number, targetId: number) => Promise<void>;
  createSlide: () => Promise<void>;
  saveSlide: (slide: Slide) => Promise<void>;
  deleteSlide: (id: number) => Promise<void>;
  uploadImage: (file: File) => Promise<string>;
  showStatus: (message: string) => void;
};

type ResponsiveTarget = 'desktop' | 'tablet' | 'mobile';

function slideImagePatch(target: ResponsiveTarget, url: string) {
  return {
    ...(target === 'desktop' ? { imageUrl: url } : {}),
    ...(target === 'tablet' ? { tabletImageUrl: url } : {}),
    ...(target === 'mobile' ? { mobileImageUrl: url } : {}),
  };
}

function popupImagePatch(target: ResponsiveTarget, url: string) {
  return {
    ...(target === 'desktop' ? { popupImageUrl: url } : {}),
    ...(target === 'tablet' ? { popupTabletImageUrl: url } : {}),
    ...(target === 'mobile' ? { popupMobileImageUrl: url } : {}),
  };
}

export function AdminSliderSection({
  slides,
  draft,
  nextSlideOrder,
  draggedSlideId,
  busy,
  savedSlideId,
  setDraft,
  setDraggedSlideId,
  updateSlide,
  moveSlide,
  createSlide,
  saveSlide,
  deleteSlide,
  uploadImage,
  showStatus,
}: AdminSliderSectionProps) {
  const uploadResponsiveImage = async (file: File, onUploaded: (url: string) => void) => {
    try {
      const url = await uploadImage(file);
      onUploaded(url);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : 'Ошибка загрузки');
    }
  };

  return (
    <section className={styles.section}>
      <h2>Слайдер</h2>

      <AdminOrderList
        items={slides}
        draggedId={draggedSlideId}
        busy={busy}
        ariaLabel="Очередность слайдов"
        dragTitle="Перетащите слайд"
        panelClassName={styles.orderPanel}
        itemClassName={styles.orderItem}
        itemDraggingClassName={styles.orderItemDragging}
        dragClassName={styles.orderDrag}
        thumbClassName={styles.orderThumb}
        numberClassName={styles.orderNumber}
        onDragStart={setDraggedSlideId}
        onDrop={(targetId) => {
          if (!draggedSlideId || draggedSlideId === targetId) {
            setDraggedSlideId(null);
            return;
          }
          void moveSlide(draggedSlideId, targetId);
          setDraggedSlideId(null);
        }}
        onDragEnd={() => setDraggedSlideId(null)}
        renderThumb={(slide, index) => (slide.imageUrl ? <img src={slide.imageUrl} alt="" /> : <span>{index + 1}</span>)}
      />

      <div className={styles.addCard}>
        <div className={styles.cardBlock}>
          <AdminResponsiveImages
            groupTitle="Слайд"
            imageUrl={draft.imageUrl}
            tabletImageUrl={draft.tabletImageUrl}
            mobileImageUrl={draft.mobileImageUrl}
            uploadLabelPrefix="Добавить/заменить слайд"
            onClear={(target) =>
              setDraft((current) => ({
                ...current,
                imageUrl: target === 'desktop' ? '' : current.imageUrl,
                tabletImageUrl: target === 'tablet' ? '' : current.tabletImageUrl,
                mobileImageUrl: target === 'mobile' ? '' : current.mobileImageUrl,
              }))
            }
            onUpload={(target, file) =>
              uploadResponsiveImage(file, (url) => setDraft((current) => ({ ...current, ...slideImagePatch(target, url) })))
            }
          />
        </div>
        <div className={styles.cardBlock}>
          <AdminResponsiveImages
            groupTitle="Попап"
            imageUrl={draft.popupImageUrl}
            tabletImageUrl={draft.popupTabletImageUrl}
            mobileImageUrl={draft.popupMobileImageUrl}
            uploadLabelPrefix="Добавить/заменить попап"
            onClear={(target) =>
              setDraft((current) => ({
                ...current,
                popupImageUrl: target === 'desktop' ? '' : current.popupImageUrl,
                popupTabletImageUrl: target === 'tablet' ? '' : current.popupTabletImageUrl,
                popupMobileImageUrl: target === 'mobile' ? '' : current.popupMobileImageUrl,
              }))
            }
            onUpload={(target, file) =>
              uploadResponsiveImage(file, (url) => setDraft((current) => ({ ...current, ...popupImagePatch(target, url) })))
            }
          />
          <div className={styles.popupFields}>
            <h3>Попап</h3>
            <input
              value={draft.popupTitle ?? ''}
              onChange={(event) => setDraft({ ...draft, popupTitle: event.target.value })}
              placeholder="Заголовок попапа"
            />
            <textarea
              value={draft.popupText ?? ''}
              onChange={(event) => setDraft({ ...draft, popupText: event.target.value })}
              placeholder="Текст попапа"
              rows={8}
            />
          </div>
        </div>
        <div className={styles.cardMeta}>
          <input
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="Название для админки"
          />
          <input
            value={draft.linkUrl ?? ''}
            onChange={(event) => setDraft({ ...draft, linkUrl: event.target.value })}
            placeholder="Ссылка при клике, необязательно"
          />
          <input type="number" value={nextSlideOrder} readOnly placeholder="Порядок" />
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={draft.isActive}
              onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })}
            />
            Показывать
          </label>
          <button disabled={busy} onClick={createSlide}>Добавить слайд</button>
        </div>
      </div>

      <div className={styles.slides}>
        {slides.map((slide) => (
          <article className={styles.slideCard} key={slide.id}>
            <div className={styles.cardBlock}>
              <AdminResponsiveImages
                groupTitle="Слайд"
                imageUrl={slide.imageUrl}
                tabletImageUrl={slide.tabletImageUrl}
                mobileImageUrl={slide.mobileImageUrl}
                uploadLabelPrefix="Добавить/заменить слайд"
                onClear={(target) => updateSlide(slide.id, slideImagePatch(target, ''))}
                onUpload={(target, file) => uploadResponsiveImage(file, (url) => updateSlide(slide.id, slideImagePatch(target, url)))}
              />
            </div>
            <div className={styles.cardBlock}>
              <AdminResponsiveImages
                groupTitle="Попап"
                imageUrl={slide.popupImageUrl}
                tabletImageUrl={slide.popupTabletImageUrl}
                mobileImageUrl={slide.popupMobileImageUrl}
                uploadLabelPrefix="Добавить/заменить попап"
                onClear={(target) => updateSlide(slide.id, popupImagePatch(target, ''))}
                onUpload={(target, file) => uploadResponsiveImage(file, (url) => updateSlide(slide.id, popupImagePatch(target, url)))}
              />
              <div className={styles.popupFields}>
                <h3>Попап</h3>
                <input
                  value={slide.popupTitle ?? ''}
                  onChange={(event) => updateSlide(slide.id, { popupTitle: event.target.value })}
                  placeholder="Заголовок попапа"
                />
                <textarea
                  value={slide.popupText ?? ''}
                  onChange={(event) => updateSlide(slide.id, { popupText: event.target.value })}
                  placeholder="Текст попапа"
                  rows={8}
                />
              </div>
            </div>
            <div className={styles.cardActions}>
              <input
                value={slide.title}
                onChange={(event) => updateSlide(slide.id, { title: event.target.value })}
                placeholder="Название для админки"
              />
              <input
                value={slide.linkUrl ?? ''}
                onChange={(event) => updateSlide(slide.id, { linkUrl: event.target.value })}
                placeholder="Ссылка при клике"
              />
              <input type="number" value={slide.sortOrder} readOnly placeholder="Порядок" />
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={slide.isActive}
                  onChange={(event) => updateSlide(slide.id, { isActive: event.target.checked })}
                />
                Показывать
              </label>
              <button
                className={savedSlideId === slide.id ? styles.savedButton : undefined}
                disabled={busy}
                onClick={() => saveSlide(slide)}
              >
                {savedSlideId === slide.id ? 'Сохранено' : 'Сохранить'}
              </button>
              <button className={styles.danger} disabled={busy} onClick={() => deleteSlide(slide.id)}>
                Удалить
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
