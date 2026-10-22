type ChatMessageState = { id: number; readByOther: boolean; readByViewer?: boolean; createdAt?: string };

function timestampParts(value?: string): [number, string] {
  if (!value) return [0, ''];
  // Preserve sub-millisecond ordering returned by PostgreSQL. Date.parse alone
  // truncates it, and can incorrectly order two messages by their IDs instead.
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/.exec(iso)?.[1] ?? '';
  const millis = Date.parse(iso.replace(/\.(\d{3})\d+/, '.$1'));
  return [Number.isFinite(millis) ? millis : 0, fraction.slice(3).padEnd(6, '0')];
}

// A POST reply and its SSE/poll refresh can arrive in either order. Preserve a
// newly sent message, deduplicate IDs and never revert an observed read receipt.
export function mergeClientChatMessages<T extends ChatMessageState>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    const merged = { ...previous, ...message, readByOther: message.readByOther || previous?.readByOther === true };
    if (previous?.readByViewer !== undefined || message.readByViewer !== undefined) {
      merged.readByViewer = message.readByViewer === true || previous?.readByViewer === true;
    }
    byId.set(message.id, merged);
  }
  return [...byId.values()].sort((a, b) => {
    const [aTime, aFraction] = timestampParts(a.createdAt);
    const [bTime, bFraction] = timestampParts(b.createdAt);
    return aTime - bTime || aFraction.localeCompare(bFraction) || a.id - b.id;
  });
}
