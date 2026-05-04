'use client';

import { ReactNode } from 'react';

import styles from '@/app/admin/admin.module.scss';

type AdminOrderListProps<T extends { id: number }> = {
  items: T[];
  draggedId: number | null;
  busy: boolean;
  ariaLabel: string;
  dragTitle: string;
  panelClassName?: string;
  itemClassName?: string;
  itemDraggingClassName?: string;
  dragClassName?: string;
  thumbClassName?: string;
  numberClassName?: string;
  onDragStart: (id: number) => void;
  onDrop: (targetId: number) => void;
  onDragEnd: () => void;
  renderThumb: (item: T, index: number) => ReactNode;
};

export function AdminOrderList<T extends { id: number }>({
  items,
  draggedId,
  busy,
  ariaLabel,
  dragTitle,
  panelClassName = styles.newsOrderPanel,
  itemClassName = styles.newsOrderItem,
  itemDraggingClassName = styles.newsOrderItemDragging,
  dragClassName = styles.newsOrderDrag,
  thumbClassName = styles.newsOrderThumb,
  numberClassName = styles.newsOrderNumber,
  onDragStart,
  onDrop,
  onDragEnd,
  renderThumb,
}: AdminOrderListProps<T>) {
  if (items.length === 0) return null;

  return (
    <div className={panelClassName} aria-label={ariaLabel}>
      {items.map((item, index) => (
        <div
          className={`${itemClassName} ${draggedId === item.id ? itemDraggingClassName : ''}`}
          draggable={!busy}
          key={item.id}
          onDragStart={() => onDragStart(item.id)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => onDrop(item.id)}
          onDragEnd={onDragEnd}
        >
          <div className={dragClassName} aria-hidden="true" title={dragTitle}>
            ⋮⋮
          </div>
          <div className={thumbClassName}>{renderThumb(item, index)}</div>
          <span className={numberClassName}>{index + 1}</span>
        </div>
      ))}
    </div>
  );
}
