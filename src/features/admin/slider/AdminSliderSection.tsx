'use client';

import { Dispatch, SetStateAction, useEffect, useMemo, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { Slide } from '@/features/admin/types';
import { AdminOrderList } from '@/features/admin/shared/AdminOrderList';
import { AdminResponsiveImages, type ResponsiveImageSizes } from '@/features/admin/shared/AdminResponsiveImages';

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
type ImageGroup = 'slide' | 'popup';
type ImageSizeInfo = {
  url: string;
  label: string;
};
type ImageSizeGroup = Partial<Record<ResponsiveTarget, ImageSizeInfo>>;
type SlideImageSizes = Record<ImageGroup, ImageSizeGroup>;
type SlideImageSource = Pick<
  Slide,
  | 'imageUrl'
  | 'tabletImageUrl'
  | 'mobileImageUrl'
  | 'popupImageUrl'
  | 'popupTabletImageUrl'
  | 'popupMobileImageUrl'
>;

const IMAGE_SIZE_PENDING = 'определяется...';
const IMAGE_SIZE_UNKNOWN = 'не удалось определить';

function createEmptyImageSizes(): SlideImageSizes {
  return { slide: {}, popup: {} };
}

function formatFileSize(bytes: number) {
  const kilobytes = bytes / 1024;

  if (kilobytes < 1024) {
    return `${Math.ceil(kilobytes)} КБ`;
  }

  return `${(kilobytes / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function formatContentLength(contentLength: string | null) {
  const bytes = Number(contentLength);

  return Number.isFinite(bytes) && bytes > 0 ? formatFileSize(bytes) : null;
}

async function readRemoteImageSize(url: string) {
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });

    return response.ok ? formatContentLength(response.headers.get('content-length')) ?? IMAGE_SIZE_UNKNOWN : IMAGE_SIZE_UNKNOWN;
  } catch {
    return IMAGE_SIZE_UNKNOWN;
  }
}

function getResponsiveImages(source: SlideImageSource, group: ImageGroup) {
  const urls: Record<ResponsiveTarget, string | null | undefined> =
    group === 'slide'
      ? {
          desktop: source.imageUrl,
          tablet: source.tabletImageUrl,
          mobile: source.mobileImageUrl,
        }
      : {
          desktop: source.popupImageUrl,
          tablet: source.popupTabletImageUrl,
          mobile: source.popupMobileImageUrl,
        };

  return (Object.entries(urls) as Array<[ResponsiveTarget, string | null | undefined]>)
    .filter((entry): entry is [ResponsiveTarget, string] => Boolean(entry[1]));
}

function toImageSizeLabels(sizes: ImageSizeGroup): ResponsiveImageSizes {
  return {
    desktop: sizes.desktop?.label,
    tablet: sizes.tablet?.label,
    mobile: sizes.mobile?.label,
  };
}

function setImageSize(current: SlideImageSizes, group: ImageGroup, target: ResponsiveTarget, url: string, label: string) {
  return {
    ...current,
    [group]: {
      ...current[group],
      [target]: { url, label },
    },
  };
}

function removeImageSize(current: SlideImageSizes, group: ImageGroup, target: ResponsiveTarget) {
  const nextGroup = { ...current[group] };
  delete nextGroup[target];

  return {
    ...current,
    [group]: nextGroup,
  };
}

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
  const [slideImageSizes, setSlideImageSizes] = useState<Record<number, SlideImageSizes>>({});
  const [draftImageSizes, setDraftImageSizes] = useState<SlideImageSizes>(() => createEmptyImageSizes());
  const draftImageSource = useMemo<SlideImageSource>(
    () => ({
      imageUrl: draft.imageUrl,
      tabletImageUrl: draft.tabletImageUrl,
      mobileImageUrl: draft.mobileImageUrl,
      popupImageUrl: draft.popupImageUrl,
      popupTabletImageUrl: draft.popupTabletImageUrl,
      popupMobileImageUrl: draft.popupMobileImageUrl,
    }),
    [
      draft.imageUrl,
      draft.tabletImageUrl,
      draft.mobileImageUrl,
      draft.popupImageUrl,
      draft.popupTabletImageUrl,
      draft.popupMobileImageUrl,
    ],
  );

  useEffect(() => {
    if (!slides.length) {
      setSlideImageSizes({});
      return;
    }

    let isMounted = true;

    setSlideImageSizes((current) => {
      const next: Record<number, SlideImageSizes> = {};

      for (const slide of slides) {
        let nextSlideSizes = createEmptyImageSizes();

        for (const group of ['slide', 'popup'] as const) {
          for (const [target, url] of getResponsiveImages(slide, group)) {
            const currentInfo = current[slide.id]?.[group]?.[target];
            nextSlideSizes = setImageSize(
              nextSlideSizes,
              group,
              target,
              url,
              currentInfo?.url === url ? currentInfo.label : IMAGE_SIZE_PENDING,
            );
          }
        }

        if (Object.keys(nextSlideSizes.slide).length || Object.keys(nextSlideSizes.popup).length) {
          next[slide.id] = nextSlideSizes;
        }
      }

      return next;
    });

    for (const slide of slides) {
      for (const group of ['slide', 'popup'] as const) {
        for (const [target, url] of getResponsiveImages(slide, group)) {
          void readRemoteImageSize(url).then((label) => {
            if (!isMounted) return;

            setSlideImageSizes((current) => {
              const currentInfo = current[slide.id]?.[group]?.[target];
              if (!currentInfo || currentInfo.url !== url) return current;

              return {
                ...current,
                [slide.id]: setImageSize(current[slide.id] ?? createEmptyImageSizes(), group, target, url, label),
              };
            });
          });
        }
      }
    }

    return () => {
      isMounted = false;
    };
  }, [slides]);

  useEffect(() => {
    let isMounted = true;

    setDraftImageSizes((current) => {
      let next = createEmptyImageSizes();

      for (const group of ['slide', 'popup'] as const) {
        for (const [target, url] of getResponsiveImages(draftImageSource, group)) {
          const currentInfo = current[group][target];
          next = setImageSize(next, group, target, url, currentInfo?.url === url ? currentInfo.label : IMAGE_SIZE_PENDING);
        }
      }

      return next;
    });

    for (const group of ['slide', 'popup'] as const) {
      for (const [target, url] of getResponsiveImages(draftImageSource, group)) {
        void readRemoteImageSize(url).then((label) => {
          if (!isMounted) return;

          setDraftImageSizes((current) => {
            const currentInfo = current[group][target];
            if (!currentInfo || currentInfo.url !== url) return current;

            return setImageSize(current, group, target, url, label);
          });
        });
      }
    }

    return () => {
      isMounted = false;
    };
  }, [draftImageSource]);

  const setDraftImageSize = (group: ImageGroup, target: ResponsiveTarget, url: string, label: string) => {
    setDraftImageSizes((current) => setImageSize(current, group, target, url, label));
  };

  const removeDraftImageSize = (group: ImageGroup, target: ResponsiveTarget) => {
    setDraftImageSizes((current) => removeImageSize(current, group, target));
  };

  const setSavedSlideImageSize = (
    slideId: number,
    group: ImageGroup,
    target: ResponsiveTarget,
    url: string,
    label: string,
  ) => {
    setSlideImageSizes((current) => ({
      ...current,
      [slideId]: setImageSize(current[slideId] ?? createEmptyImageSizes(), group, target, url, label),
    }));
  };

  const removeSavedSlideImageSize = (slideId: number, group: ImageGroup, target: ResponsiveTarget) => {
    setSlideImageSizes((current) => ({
      ...current,
      [slideId]: removeImageSize(current[slideId] ?? createEmptyImageSizes(), group, target),
    }));
  };

  const uploadResponsiveImage = async (file: File, onUploaded: (url: string, sizeLabel: string) => void) => {
    try {
      const sizeLabel = formatFileSize(file.size);
      const url = await uploadImage(file);
      onUploaded(url, sizeLabel);
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
            imageSizes={toImageSizeLabels(draftImageSizes.slide)}
            uploadLabelPrefix="Добавить/заменить слайд"
            onClear={(target) => {
              setDraft((current) => ({
                ...current,
                imageUrl: target === 'desktop' ? '' : current.imageUrl,
                tabletImageUrl: target === 'tablet' ? '' : current.tabletImageUrl,
                mobileImageUrl: target === 'mobile' ? '' : current.mobileImageUrl,
              }));
              removeDraftImageSize('slide', target);
            }}
            onUpload={(target, file) =>
              uploadResponsiveImage(file, (url, sizeLabel) => {
                setDraft((current) => ({ ...current, ...slideImagePatch(target, url) }));
                setDraftImageSize('slide', target, url, sizeLabel);
              })
            }
          />
        </div>
        <div className={styles.cardBlock}>
          <AdminResponsiveImages
            groupTitle="Попап"
            imageUrl={draft.popupImageUrl}
            tabletImageUrl={draft.popupTabletImageUrl}
            mobileImageUrl={draft.popupMobileImageUrl}
            imageSizes={toImageSizeLabels(draftImageSizes.popup)}
            uploadLabelPrefix="Добавить/заменить попап"
            onClear={(target) => {
              setDraft((current) => ({
                ...current,
                popupImageUrl: target === 'desktop' ? '' : current.popupImageUrl,
                popupTabletImageUrl: target === 'tablet' ? '' : current.popupTabletImageUrl,
                popupMobileImageUrl: target === 'mobile' ? '' : current.popupMobileImageUrl,
              }));
              removeDraftImageSize('popup', target);
            }}
            onUpload={(target, file) =>
              uploadResponsiveImage(file, (url, sizeLabel) => {
                setDraft((current) => ({ ...current, ...popupImagePatch(target, url) }));
                setDraftImageSize('popup', target, url, sizeLabel);
              })
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
                imageSizes={toImageSizeLabels(slideImageSizes[slide.id]?.slide ?? {})}
                uploadLabelPrefix="Добавить/заменить слайд"
                onClear={(target) => {
                  updateSlide(slide.id, slideImagePatch(target, ''));
                  removeSavedSlideImageSize(slide.id, 'slide', target);
                }}
                onUpload={(target, file) =>
                  uploadResponsiveImage(file, (url, sizeLabel) => {
                    updateSlide(slide.id, slideImagePatch(target, url));
                    setSavedSlideImageSize(slide.id, 'slide', target, url, sizeLabel);
                  })
                }
              />
            </div>
            <div className={styles.cardBlock}>
              <AdminResponsiveImages
                groupTitle="Попап"
                imageUrl={slide.popupImageUrl}
                tabletImageUrl={slide.popupTabletImageUrl}
                mobileImageUrl={slide.popupMobileImageUrl}
                imageSizes={toImageSizeLabels(slideImageSizes[slide.id]?.popup ?? {})}
                uploadLabelPrefix="Добавить/заменить попап"
                onClear={(target) => {
                  updateSlide(slide.id, popupImagePatch(target, ''));
                  removeSavedSlideImageSize(slide.id, 'popup', target);
                }}
                onUpload={(target, file) =>
                  uploadResponsiveImage(file, (url, sizeLabel) => {
                    updateSlide(slide.id, popupImagePatch(target, url));
                    setSavedSlideImageSize(slide.id, 'popup', target, url, sizeLabel);
                  })
                }
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
