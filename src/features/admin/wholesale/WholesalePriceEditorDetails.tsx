import type { Dispatch, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { WHOLESALE_PRICE_WORKFLOW_STATUSES, type WholesalePriceWorkflowStatus } from '@/shared/lib/wholesalePriceWorkflowStatus';

import type { ClientCompanyOption, Manager, PriceEditor } from './AdminWholesaleModel';

type WholesalePriceEditorDetailsProps = {
  screen: 'create' | 'edit';
  editor: PriceEditor;
  setEditor: Dispatch<SetStateAction<PriceEditor>>;
  commentRows: number;
  canManageWholesale: boolean;
  clientCompanies: ClientCompanyOption[];
  developmentManagers: Manager[];
  supportManagers: Manager[];
};

export function WholesalePriceEditorDetails({
  screen,
  editor,
  setEditor,
  commentRows,
  canManageWholesale,
  clientCompanies,
  developmentManagers,
  supportManagers,
}: WholesalePriceEditorDetailsProps) {
  const selectedClientCompany =
    clientCompanies.find((company) => company.id === editor.clientCompanyId) ??
    clientCompanies.find((company) => company.title.trim().toLowerCase() === editor.clientName.trim().toLowerCase()) ??
    null;
  const hasLegacyClientName = Boolean(editor.clientName.trim() && !selectedClientCompany);

  return (
    <div className={styles.wholesaleEditorGrid}>
      <label>
        <span>Название прайса</span>
        <input value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} />
      </label>
      <label>
        <span>Клиент / компания</span>
        <select
          value={selectedClientCompany?.id ?? ''}
          onChange={(event) => {
            const companyId = Number(event.target.value);
            const company = clientCompanies.find((item) => item.id === companyId) ?? null;
            setEditor({
              ...editor,
              clientCompanyId: company?.id ?? null,
              clientName: company?.title ?? '',
            });
          }}
          disabled={clientCompanies.length === 0}
        >
          <option value="">Выберите клиента</option>
          {clientCompanies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.title}
            </option>
          ))}
        </select>
        {hasLegacyClientName ? (
          <span className={styles.fieldHint}>Текущий клиент не выбран из списка: {editor.clientName}</span>
        ) : null}
      </label>
      <label>
        <span>Token ссылки</span>
        <input
          value={editor.token}
          disabled={screen === 'edit'}
          onChange={(event) => setEditor({ ...editor, token: event.target.value })}
        />
      </label>
      <label>
        <span>Срок действия</span>
        <input type="date" value={editor.validUntil} onChange={(event) => setEditor({ ...editor, validUntil: event.target.value })} />
      </label>
      <label>
        <span>Статус прайса</span>
        <select
          value={editor.workflowStatus}
          onChange={(event) => setEditor({ ...editor, workflowStatus: event.target.value as WholesalePriceWorkflowStatus })}
        >
          {WHOLESALE_PRICE_WORKFLOW_STATUSES.map((statusItem) => (
            <option key={statusItem.value} value={statusItem.value}>
              {statusItem.label}
            </option>
          ))}
        </select>
      </label>
      {canManageWholesale && (
        <label>
          <span>Менеджер</span>
          <select value={editor.managerId ?? ''} onChange={(event) => setEditor({ ...editor, managerId: event.target.value ? Number(event.target.value) : null })}>
            <option value="">Не назначен</option>
            {developmentManagers.map((manager) => (
              <option key={manager.id} value={manager.id}>{manager.name}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>Менеджер по сопровождению</span>
        <select
          required
          value={editor.supportManagerId ?? ''}
          onChange={(event) => setEditor({ ...editor, supportManagerId: event.target.value ? Number(event.target.value) : null })}
          disabled={supportManagers.length === 0}
        >
          <option value="">Не выбран</option>
          {supportManagers.map((manager) => (
            <option key={manager.id} value={manager.id}>{manager.name || manager.login}</option>
          ))}
        </select>
      </label>
      <label className={styles.wholesaleWide}>
        <span>Комментарий</span>
        <textarea rows={commentRows} value={editor.comment} onChange={(event) => setEditor({ ...editor, comment: event.target.value })} />
      </label>
      <label className={styles.checkbox}>
        <input type="checkbox" checked={editor.isActive} onChange={(event) => setEditor({ ...editor, isActive: event.target.checked })} />
        Активен
      </label>
      <label className={styles.checkbox}>
        <input type="checkbox" checked={editor.showStock} onChange={(event) => setEditor({ ...editor, showStock: event.target.checked })} />
        Показывать остатки цифрами
      </label>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={editor.showStockText}
          onChange={(event) => setEditor({ ...editor, showStockText: event.target.checked })}
        />
        Показывать остатки текстом
      </label>
      <label className={styles.checkbox}>
        <input type="checkbox" checked={editor.showRetailPrices} onChange={(event) => setEditor({ ...editor, showRetailPrices: event.target.checked })} />
        Показать розничные цены
      </label>
    </div>
  );
}
