type ChatMessageState = { id: number; readByOther: boolean; createdAt?: string };

// A POST reply and its SSE/poll refresh can arrive in either order. Preserve a
// newly sent message, deduplicate IDs and never revert an observed read receipt.
export function mergeClientChatMessages<T extends ChatMessageState>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    byId.set(message.id, { ...message, readByOther: message.readByOther || previous?.readByOther === true });
  }
  return [...byId.values()].sort((a, b) => {
    const timeDifference = a.createdAt && b.createdAt ? Date.parse(a.createdAt) - Date.parse(b.createdAt) : 0;
    return (Number.isFinite(timeDifference) ? timeDifference : 0) || a.id - b.id;
  }).slice(-300);
}
