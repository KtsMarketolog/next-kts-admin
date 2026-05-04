type OrderedItem = {
  id: number;
  sortOrder: number;
};

export function reorderByDrop<T extends OrderedItem>(items: T[], draggedId: number, targetId: number) {
  const currentIndex = items.findIndex((item) => item.id === draggedId);
  const nextIndex = items.findIndex((item) => item.id === targetId);
  if (currentIndex < 0 || nextIndex < 0 || currentIndex === nextIndex) return null;

  const reordered = [...items];
  const [moved] = reordered.splice(currentIndex, 1);
  if (!moved) return null;

  reordered.splice(nextIndex, 0, moved);
  return reordered.map((item, index) => ({ ...item, sortOrder: index + 1 }));
}
