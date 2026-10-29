'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import styles from './knowledge-base.module.scss';

export function KnowledgeBaseDialog({ title, children, onClose, busy = false, preview = false, fullWidth = false }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean; preview?: boolean; fullWidth?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className={`${styles.modal} ${styles.controls} ${preview ? styles.preview : ''} ${fullWidth ? styles.fullWidthPreview : ''}`}
    aria-labelledby="kb-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className={styles.modalHeader}><h2 id="kb-dialog-title">{title}</h2>
      <button type="button" onClick={onClose} disabled={busy}>Закрыть</button></div>
    {children}
  </dialog>;
}
