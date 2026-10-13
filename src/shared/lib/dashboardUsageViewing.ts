import type { DashboardUsageBatch, DashboardUsageEvent } from './dashboardUsage';

type Context = Omit<DashboardUsageBatch, 'events'>;
type Registration = { context: Context; visible: boolean };

/** Measures visible report time, not attention, productivity or a completed calculation. */
export class DashboardUsageViewing {
  private registrations = new Set<Registration>();
  private startedAt: number;
  constructor(private emit: (context: Context, event: DashboardUsageEvent) => void,
    private now = () => performance.now(), private id = () => crypto.randomUUID().replaceAll('-', '')) {
    this.startedAt = this.now();
  }

  register(context: Context) {
    const registration: Registration = { context, visible: false };
    this.registrations.add(registration);
    return {
      setVisible: (visible: boolean) => {
        if (!this.registrations.has(registration) || registration.visible === visible) return;
        // Every window covers one unchanged visible set, so MAX across reports is employee time.
        this.flush();
        registration.visible = visible;
        this.startedAt = this.now();
      },
      dispose: () => {
        if (!this.registrations.has(registration)) return;
        this.flush();
        this.registrations.delete(registration);
        this.startedAt = this.now();
      },
    };
  }

  flush = () => {
    const now = this.now();
    // Never infer hours of presence after a suspended tab or sleeping device.
    const durationSeconds = Math.min(60, Math.max(0, Math.floor((now - this.startedAt) / 1000)));
    this.startedAt = now;
    if (!durationSeconds) return;
    const contexts = new Map<string, Context>();
    for (const registration of this.registrations) {
      if (registration.visible) contexts.set(JSON.stringify(registration.context), registration.context);
    }
    if (!contexts.size) return;
    const viewingWindowId = this.id();
    for (const context of contexts.values()) this.emit(context, { id: this.id(), action: 'viewing_time', durationSeconds, viewingWindowId });
  };
}
