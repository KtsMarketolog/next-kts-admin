'use client';

import { useRef, useState, type DragEvent } from 'react';
import type { KnowledgeBaseNode } from '@/shared/lib/knowledgeBase';

const MOVE_MIME = 'application/x-kts-knowledge-base-node';

/** Only drags begun by this list can open a move preview; external files never become moves. */
export function useKnowledgeBaseDrag(enabled: boolean, onDrop: (node: KnowledgeBaseNode, parentId: number | null) => void) {
  const source = useRef<KnowledgeBaseNode | null>(null);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | 'root' | null>(null);
  const clear = () => { source.current = null; setDraggedId(null); setOverId(null); };
  const valid = (parentId: number | null) => enabled && !!source.current && source.current.id !== parentId
    && source.current.parentId !== parentId && (parentId !== null || source.current.kind === 'folder');
  const start = (node: KnowledgeBaseNode, event: DragEvent) => {
    if (!enabled || node.archivedAt) { event.preventDefault(); return; }
    source.current = node; setDraggedId(node.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(MOVE_MIME, String(node.id));
  };
  const internalType = (event: DragEvent) => event.dataTransfer.types.includes(MOVE_MIME) && !event.dataTransfer.types.includes('Files');
  const targetProps = (parentId: number | null) => ({
    onDragOver: (event: DragEvent) => {
      if (!valid(parentId) || !internalType(event)) {
        // Also suppress the browser's default "open dropped URL/file" navigation.
        event.preventDefault(); event.dataTransfer.dropEffect = 'none';
        return;
      }
      event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOverId(parentId ?? 'root');
    },
    onDragLeave: (event: DragEvent) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setOverId((current) => current === (parentId ?? 'root') ? null : current);
    },
    onDrop: (event: DragEvent) => {
      if (!valid(parentId) || !internalType(event) || event.dataTransfer.getData(MOVE_MIME) !== String(source.current?.id)) {
        event.preventDefault(); return;
      }
      event.preventDefault(); event.stopPropagation();
      const node = source.current!; clear(); onDrop(node, parentId);
    },
  });
  return { start, clear, targetProps, valid, draggedId: enabled ? draggedId : null, overId: enabled ? overId : null };
}
