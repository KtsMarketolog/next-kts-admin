type OrderedItem = {
  id: number;
  sortOrder: number;
};

export class ContentOrderAcknowledgementError extends Error {
  constructor() {
    super('Сервер не подтвердил полный порядок элементов');
    this.name = 'ContentOrderAcknowledgementError';
  }
}

/** The wire contract deliberately excludes editable content fields. */
export function reorderRequest(url: string, items: OrderedItem[]) {
  return { url: `${url}/reorder`, init: {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: items.map(({ id, sortOrder }) => ({ id, sortOrder })) }),
  } };
}

/** Validate the entire acknowledgement before changing any local order. */
export async function readConfirmedOrder(response: Response, expected: OrderedItem[], signal: AbortSignal) {
  let data: unknown;
  try { data = await response.json(); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new ContentOrderAcknowledgementError();
  }
  signal.throwIfAborted();
  const invalid = () => new ContentOrderAcknowledgementError();
  if (!data || typeof data !== 'object' || !('ok' in data) || data.ok !== true || !('items' in data) || !Array.isArray(data.items) || data.items.length !== expected.length) throw invalid();
  const requested = new Map(expected.map(({ id, sortOrder }) => [id, sortOrder]));
  const confirmed = new Set<number>();
  for (const item of data.items) {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.sortOrder) || confirmed.has(item.id) || requested.get(item.id) !== item.sortOrder) throw invalid();
    confirmed.add(item.id);
  }
  if (confirmed.size !== requested.size) throw invalid();
  return 'warnings' in data && Array.isArray(data.warnings)
    ? data.warnings.flatMap((warning: unknown) => warning && typeof warning === 'object' && 'message' in warning && typeof warning.message === 'string' ? [warning.message] : [])
    : [];
}

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
