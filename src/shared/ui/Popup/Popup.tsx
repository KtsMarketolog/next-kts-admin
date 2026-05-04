'use client';

import React, { useEffect } from 'react';
import styles from './Popup.module.scss';

type PopupProps = {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** max-width модалки задаём через CSS var --popup-w + классы */
  className?: string;
  closeOnOverlay?: boolean;
  scrollContent?: boolean;
  ariaLabel?: string;
};

const Popup: React.FC<PopupProps> = ({
  open,
  onClose,
  children,
  className,
  closeOnOverlay = true,
  scrollContent = true,
  ariaLabel = 'Модальное окно',
}) => {
  useEffect(() => {
    if (!open) return;
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.body.style.paddingRight = `${sbw}px`;
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onEsc);
    return () => {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
      window.removeEventListener('keydown', onEsc);
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={closeOnOverlay ? onClose : undefined}
    >
      <div
        className={`${styles.modal} ${scrollContent ? styles.scrollable : ''} ${className ?? ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className={styles.close} aria-label="Закрыть" onClick={onClose}>×</button>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
};

export default Popup;
