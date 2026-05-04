'use client';

import { Dispatch, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { GroupCompany } from '@/features/admin/types';
import { AdminImagePicker } from '@/features/admin/shared/AdminImagePicker';
import { AdminOrderList } from '@/features/admin/shared/AdminOrderList';

type AdminGroupCompaniesSectionProps = {
  groupCompanies: GroupCompany[];
  groupCompanyDraft: Omit<GroupCompany, 'id'>;
  nextGroupCompanyOrder: number;
  draggedGroupCompanyId: number | null;
  busy: boolean;
  groupCompanyCreated: boolean;
  setGroupCompanyDraft: Dispatch<SetStateAction<Omit<GroupCompany, 'id'>>>;
  setDraggedGroupCompanyId: (id: number | null) => void;
  updateGroupCompany: (id: number, patch: Partial<GroupCompany>) => void;
  moveGroupCompany: (draggedId: number, targetId: number) => Promise<void>;
  createGroupCompany: () => Promise<void>;
  saveGroupCompany: (company: GroupCompany) => Promise<void>;
  deleteGroupCompany: (id: number) => Promise<void>;
  uploadImage: (file: File) => Promise<string>;
  showStatus: (message: string) => void;
};

export function AdminGroupCompaniesSection({
  groupCompanies,
  groupCompanyDraft,
  nextGroupCompanyOrder,
  draggedGroupCompanyId,
  busy,
  groupCompanyCreated,
  setGroupCompanyDraft,
  setDraggedGroupCompanyId,
  updateGroupCompany,
  moveGroupCompany,
  createGroupCompany,
  saveGroupCompany,
  deleteGroupCompany,
  uploadImage,
  showStatus,
}: AdminGroupCompaniesSectionProps) {
  const uploadCompanyImage = async (file: File, onUploaded: (url: string) => void) => {
    try {
      const url = await uploadImage(file);
      onUploaded(url);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : 'Ошибка загрузки');
    }
  };

  return (
    <section className={styles.section}>
      <h2>Группа компаний</h2>

      <AdminOrderList
        items={groupCompanies}
        draggedId={draggedGroupCompanyId}
        busy={busy}
        ariaLabel="Очередность группы компаний"
        dragTitle="Перетащите компанию"
        onDragStart={setDraggedGroupCompanyId}
        onDrop={(targetId) => {
          if (!draggedGroupCompanyId || draggedGroupCompanyId === targetId) {
            setDraggedGroupCompanyId(null);
            return;
          }
          void moveGroupCompany(draggedGroupCompanyId, targetId);
          setDraggedGroupCompanyId(null);
        }}
        onDragEnd={() => setDraggedGroupCompanyId(null)}
        renderThumb={(company, index) =>
          company.imageUrl ? <img src={company.imageUrl} alt="" /> : <span>{index + 1}</span>
        }
      />

      <div className={styles.newsCard}>
        <AdminImagePicker
          imageUrl={groupCompanyDraft.imageUrl}
          onUpload={(file) =>
            uploadCompanyImage(file, (url) => setGroupCompanyDraft((current) => ({ ...current, imageUrl: url })))
          }
        />
        <div className={styles.newsFields}>
          <input type="number" value={nextGroupCompanyOrder} readOnly placeholder="Позиция" />
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={groupCompanyDraft.isActive}
              onChange={(event) => setGroupCompanyDraft({ ...groupCompanyDraft, isActive: event.target.checked })}
            />
            Показывать
          </label>
          <button
            className={`${styles.compactButton} ${groupCompanyCreated ? styles.savedButton : ''}`}
            disabled={busy}
            onClick={createGroupCompany}
          >
            {groupCompanyCreated ? 'Компания добавлена' : 'Добавить компанию'}
          </button>
        </div>
      </div>

      <div className={styles.newsList}>
        {groupCompanies.map((company) => (
          <article className={styles.newsCard} key={company.id}>
            <AdminImagePicker
              imageUrl={company.imageUrl}
              onUpload={(file) => uploadCompanyImage(file, (url) => updateGroupCompany(company.id, { imageUrl: url }))}
            />
            <div className={styles.newsFields}>
              <input type="number" value={company.sortOrder} readOnly placeholder="Позиция" />
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={company.isActive}
                  onChange={(event) => updateGroupCompany(company.id, { isActive: event.target.checked })}
                />
                Показывать
              </label>
              <div className={styles.actions}>
                <button disabled={busy} onClick={() => saveGroupCompany(company)}>
                  Сохранить
                </button>
                <button className={styles.danger} disabled={busy} onClick={() => deleteGroupCompany(company.id)}>
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
