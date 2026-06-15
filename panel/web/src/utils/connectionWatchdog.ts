interface ReconnectWatchdogOptions {
  name: string;
  initialDelayMs: number;
  maxDelayMs: number;
  reconnect: () => void | Promise<void>;
  shouldReconnect?: () => boolean;
}

interface ProbeWatchdogOptions {
  name: string;
  intervalMs: number;
  probe: () => void | Promise<void>;
  immediate?: boolean;
}

function logWatchdogError(name: string, action: string, error: unknown): void {
  console.warn(`[watchdog:${name}] ${action}失败`, error);
}

export class ReconnectWatchdog {
  private timer: number | undefined;
  private delayMs: number;
  private disposed = false;

  constructor(private readonly options: ReconnectWatchdogOptions) {
    this.delayMs = options.initialDelayMs;
  }

  schedule(): void {
    if (this.disposed || this.timer) return;
    if (this.options.shouldReconnect && !this.options.shouldReconnect()) return;

    const delay = this.delayMs;
    this.delayMs = Math.min(this.delayMs * 2, this.options.maxDelayMs);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || (this.options.shouldReconnect && !this.options.shouldReconnect())) return;
      Promise.resolve(this.options.reconnect()).catch((error) => logWatchdogError(this.options.name, '重连', error));
    }, delay);
  }

  reset(): void {
    this.delayMs = this.options.initialDelayMs;
    this.cancel();
  }

  cancel(): void {
    if (!this.timer) return;
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  destroy(): void {
    this.disposed = true;
    this.cancel();
  }
}

export function startProbeWatchdog(options: ProbeWatchdogOptions): () => void {
  let disposed = false;
  let timer: number | undefined;
  let running = false;

  const schedule = () => {
    if (disposed) return;
    timer = window.setTimeout(tick, options.intervalMs);
  };

  const tick = () => {
    if (disposed) return;
    if (running) {
      schedule();
      return;
    }
    running = true;
    Promise.resolve(options.probe())
      .catch((error) => logWatchdogError(options.name, '探测', error))
      .finally(() => {
        running = false;
        schedule();
      });
  };

  if (options.immediate) tick();
  else schedule();

  return () => {
    disposed = true;
    if (timer) window.clearTimeout(timer);
    timer = undefined;
  };
}
