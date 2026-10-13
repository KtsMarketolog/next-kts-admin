type SchedulerWorker = Pick<Worker, 'onmessage' | 'onerror' | 'terminate'>;
type WorkerResource = { worker: SchedulerWorker; release: () => void };
type SchedulerDependencies = {
  createWorker: () => WorkerResource;
  setInterval: (callback: () => void, milliseconds: number) => number;
  clearInterval: (timer: number) => void;
  tick: () => void;
};
export const CURRENCY_SCHEDULER_INTERVAL_MS = 1000;

/** The host creates this fixed program. No iframe code, URL or interval is accepted. */
export function createCurrencySchedulerWorker(): WorkerResource {
  const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage("tick"), 1000);'], { type: 'text/javascript' }));
  try {
    const worker = new Worker(url);
    return { worker, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** A disposable clock only; the report owns due times and allowed refresh jobs. */
export function createCurrencyDashboardScheduler(deps: SchedulerDependencies) {
  let running = false;
  let generation = 0;
  let resource: WorkerResource | null = null;
  let timer: number | null = null;
  const releaseWorker = () => {
    if (!resource) return;
    const current = resource;
    resource = null;
    current.worker.onmessage = null;
    current.worker.onerror = null;
    try { current.worker.terminate(); } finally { current.release(); }
  };
  return {
    start() {
      if (running) return;
      running = true;
      const epoch = ++generation;
      const tick = () => { if (running && epoch === generation) deps.tick(); };
      const fallback = () => {
        if (running && epoch === generation && timer === null) timer = deps.setInterval(tick, CURRENCY_SCHEDULER_INTERVAL_MS);
      };
      try {
        const created = deps.createWorker();
        resource = created;
        created.worker.onmessage = (event) => { if (event.data === 'tick' && resource === created) tick(); };
        created.worker.onerror = (event) => {
          if (!running || epoch !== generation || resource !== created) return;
          event.preventDefault();
          releaseWorker();
          fallback();
        };
      } catch { releaseWorker(); fallback(); }
    },
    stop() {
      running = false;
      generation++;
      releaseWorker();
      if (timer !== null) { deps.clearInterval(timer); timer = null; }
    },
    tick() { if (running) deps.tick(); },
  };
}
