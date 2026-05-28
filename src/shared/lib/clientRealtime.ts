export type ClientRealtimeEventType = 'chat.updated' | 'documents.updated';

export type ClientRealtimeEvent = {
  id: number;
  type: ClientRealtimeEventType;
  companyId: number;
  emittedAt: string;
};

type ClientRealtimeEventInput = {
  type: ClientRealtimeEventType;
  companyId: number;
};

type ClientRealtimeListener = (event: ClientRealtimeEvent) => void;

type ClientRealtimeStore = {
  listeners: Set<ClientRealtimeListener>;
  sequence: number;
};

const globalStore = globalThis as typeof globalThis & {
  __ktsClientRealtime?: ClientRealtimeStore;
};

const store =
  globalStore.__ktsClientRealtime ??
  (globalStore.__ktsClientRealtime = {
    listeners: new Set<ClientRealtimeListener>(),
    sequence: 0,
  });

export function publishClientRealtimeEvent(input: ClientRealtimeEventInput) {
  const event: ClientRealtimeEvent = {
    ...input,
    id: ++store.sequence,
    emittedAt: new Date().toISOString(),
  };

  for (const listener of store.listeners) {
    listener(event);
  }
}

export function subscribeClientRealtime(listener: ClientRealtimeListener) {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

const encoder = new TextEncoder();
const SSE_HEARTBEAT_INTERVAL_MS = 25000;

function formatSseMessage(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createClientRealtimeStream(filter: (event: ClientRealtimeEvent) => boolean) {
  let cleanup = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};

      const stop = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
      };

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };

      send(formatSseMessage('connected', { ok: true, now: new Date().toISOString() }));
      if (closed) {
        cleanup = stop;
        return;
      }

      unsubscribe = subscribeClientRealtime((event) => {
        if (!filter(event)) return;
        send(formatSseMessage(event.type, event));
      });

      const heartbeatId = setInterval(() => {
        send(`: heartbeat ${Date.now()}\n\n`);
      }, SSE_HEARTBEAT_INTERVAL_MS);

      cleanup = () => {
        stop();
        clearInterval(heartbeatId);
      };
    },
    cancel() {
      cleanup();
    },
  });
}

export const clientRealtimeHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};
