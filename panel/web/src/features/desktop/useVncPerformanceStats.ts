import { useEffect, useState, type RefObject } from 'react';
import { api } from '../../api';

export interface VncFrameResolution {
  width: number;
  height: number;
}

export interface VncPerformanceStats {
  latencyMs: number | null;
  latencyJitterMs: number | null;
  fps: number | null;
  frameIntervalMs: number | null;
  resolution: VncFrameResolution | null;
  viewport: VncFrameResolution | null;
  scalePercent: number | null;
  devicePixelRatio: number | null;
  heapUsedBytes: number | null;
  websocketBufferedBytes: number | null;
}

const EMPTY_STATS: VncPerformanceStats = {
  latencyMs: null,
  latencyJitterMs: null,
  fps: null,
  frameIntervalMs: null,
  resolution: null,
  viewport: null,
  scalePercent: null,
  devicePixelRatio: null,
  heapUsedBytes: null,
  websocketBufferedBytes: null,
};
const LATENCY_SAMPLE_SIZE = 6;

export function useVncPerformanceStats({
  active,
  showVnc,
  frameLoaded,
  frameRef,
}: {
  active: boolean;
  showVnc: boolean;
  frameLoaded: boolean;
  frameRef: RefObject<HTMLIFrameElement>;
}): VncPerformanceStats {
  const [stats, setStats] = useState<VncPerformanceStats>(EMPTY_STATS);
  const enabled = active && showVnc && frameLoaded;

  useEffect(() => {
    if (enabled) return;
    setStats(EMPTY_STATS);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let renderedFrames = 0;
    let sampleSeen = false;
    let lastDrawCount: number | null = null;
    let sampleStartedAt = performance.now();
    let rafId = 0;

    const tick = (now: number) => {
      if (stopped) return;

      installCanvasDrawMonitor(frameRef.current);
      const drawCount = readCanvasDrawCount(frameRef.current);
      if (drawCount !== null) {
        sampleSeen = true;
        if (lastDrawCount !== null) renderedFrames += Math.max(0, drawCount - lastDrawCount);
        lastDrawCount = drawCount;
      }

      const elapsed = now - sampleStartedAt;
      if (elapsed >= 1000) {
        const fps = sampleSeen ? Math.max(0, Math.round((renderedFrames * 1000) / elapsed)) : null;
        const frameIntervalMs = fps && fps > 0 ? Math.round(1000 / fps) : null;
        setStats((current) =>
          current.fps === fps && current.frameIntervalMs === frameIntervalMs
            ? current
            : { ...current, fps, frameIntervalMs },
        );
        renderedFrames = 0;
        sampleSeen = false;
        sampleStartedAt = now;
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [enabled, frameRef]);

  useEffect(() => {
    if (!enabled) return;

    const syncRuntimeStats = () => {
      const runtimeStats = readRuntimeStats(frameRef.current);
      setStats((current) =>
        sameRuntimeStats(current, runtimeStats) ? current : { ...current, ...runtimeStats },
      );
    };

    syncRuntimeStats();
    const interval = window.setInterval(syncRuntimeStats, 1000);
    const observer = new ResizeObserver(syncRuntimeStats);
    if (frameRef.current) observer.observe(frameRef.current);

    return () => {
      window.clearInterval(interval);
      observer.disconnect();
    };
  }, [enabled, frameRef]);

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let timer = 0;
    const latencySamples: number[] = [];

    const measureLatency = async () => {
      const startedAt = performance.now();
      try {
        await api.ping();
        if (stopped) return;
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
        latencySamples.push(latencyMs);
        if (latencySamples.length > LATENCY_SAMPLE_SIZE) latencySamples.shift();
        const latencyJitterMs = latencySamples.length >= 2 ? calculateJitter(latencySamples) : null;
        setStats((current) =>
          current.latencyMs === latencyMs && current.latencyJitterMs === latencyJitterMs
            ? current
            : { ...current, latencyMs, latencyJitterMs },
        );
      } catch {
        if (!stopped) {
          setStats((current) =>
            current.latencyMs === null && current.latencyJitterMs === null
              ? current
              : { ...current, latencyMs: null, latencyJitterMs: null },
          );
        }
      }

      if (!stopped) timer = window.setTimeout(measureLatency, 5000);
    };

    void measureLatency();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [enabled]);

  return stats;
}

function readRuntimeStats(frame: HTMLIFrameElement | null): Pick<
  VncPerformanceStats,
  'resolution' | 'viewport' | 'scalePercent' | 'devicePixelRatio' | 'heapUsedBytes' | 'websocketBufferedBytes'
> {
  return {
    ...readFrameGeometry(frame),
    devicePixelRatio: readDevicePixelRatio(frame),
    heapUsedBytes: readHeapUsedBytes(),
    websocketBufferedBytes: readWebsocketBufferedBytes(frame),
  };
}

function installCanvasDrawMonitor(frame: HTMLIFrameElement | null): boolean {
  try {
    const win = frame?.contentWindow as (Window & {
      CanvasRenderingContext2D?: typeof CanvasRenderingContext2D;
      __wocCanvasDrawStats?: { count: number; pending: boolean; installed: boolean };
    }) | null;
    const proto = win?.CanvasRenderingContext2D?.prototype as Record<string, unknown> | undefined;
    if (!win || !proto) return false;
    if (win.__wocCanvasDrawStats?.installed) return true;

    const stats = { count: 0, pending: false, installed: true };
    win.__wocCanvasDrawStats = stats;
    const methodNames = ['drawImage', 'putImageData', 'fillRect', 'stroke', 'fill', 'clearRect'] as const;
    const markDraw = () => {
      if (stats.pending) return;
      stats.pending = true;
      win.requestAnimationFrame(() => {
        stats.count += 1;
        stats.pending = false;
      });
    };

    methodNames.forEach((methodName) => {
      const original = proto[methodName];
      if (typeof original !== 'function') return;
      proto[methodName] = function patchedCanvasDraw(this: CanvasRenderingContext2D, ...args: unknown[]) {
        markDraw();
        return original.apply(this, args);
      };
    });
    return true;
  } catch {
    return false;
  }
}

function readCanvasDrawCount(frame: HTMLIFrameElement | null): number | null {
  try {
    const win = frame?.contentWindow as (Window & {
      __wocCanvasDrawStats?: { count: number };
    }) | null;
    const count = win?.__wocCanvasDrawStats?.count;
    if (typeof count !== 'number' || !Number.isFinite(count)) return null;
    return count;
  } catch {
    return null;
  }
}

function readNativeCanvasSize(frame: HTMLIFrameElement | null): VncFrameResolution | null {
  try {
    const canvas = frame?.contentDocument?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return null;
    return sizeOrNull(canvas.width, canvas.height);
  } catch {
    return null;
  }
}

function readRenderedCanvasSize(frame: HTMLIFrameElement | null): VncFrameResolution | null {
  try {
    const canvas = frame?.contentDocument?.querySelector('canvas') as HTMLCanvasElement | null;
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return null;
    return sizeOrNull(rect.width, rect.height);
  } catch {
    return null;
  }
}

function readFrameDocumentSize(frame: HTMLIFrameElement | null): VncFrameResolution | null {
  try {
    const doc = frame?.contentDocument;
    return sizeOrNull(doc?.documentElement.clientWidth, doc?.documentElement.clientHeight);
  } catch {
    return null;
  }
}

function readFrameElementSize(frame: HTMLIFrameElement | null): VncFrameResolution | null {
  return sizeOrNull(frame?.clientWidth, frame?.clientHeight);
}

function readFallbackGeometry(frame: HTMLIFrameElement | null): Pick<
  VncPerformanceStats,
  'resolution' | 'viewport' | 'scalePercent'
> {
  const viewport = readFrameElementSize(frame);
  return {
    resolution: viewport,
    viewport,
    scalePercent: viewport ? 100 : null,
  };
}

function readCanvasGeometry(frame: HTMLIFrameElement | null): Pick<
  VncPerformanceStats,
  'resolution' | 'viewport' | 'scalePercent'
> {
  const resolution = readNativeCanvasSize(frame) || readFrameDocumentSize(frame) || readFrameElementSize(frame);
  const viewport = readRenderedCanvasSize(frame) || readFrameElementSize(frame);
  return {
    resolution,
    viewport,
    scalePercent: calculateScalePercent(resolution, viewport),
  };
}

function readFrameGeometry(frame: HTMLIFrameElement | null): Pick<
  VncPerformanceStats,
  'resolution' | 'viewport' | 'scalePercent'
> {
  try {
    return readCanvasGeometry(frame);
  } catch {
    return readFallbackGeometry(frame);
  }
}

function readDevicePixelRatio(frame: HTMLIFrameElement | null): number | null {
  try {
    const ratio = frame?.contentWindow?.devicePixelRatio || window.devicePixelRatio;
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    return Math.round(ratio * 100) / 100;
  } catch {
    return Number.isFinite(window.devicePixelRatio) ? Math.round(window.devicePixelRatio * 100) / 100 : null;
  }
}

function readHeapUsedBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const used = memory?.usedJSHeapSize;
  return typeof used === 'number' && Number.isFinite(used) && used >= 0 ? used : null;
}

function readWebsocketBufferedBytes(frame: HTMLIFrameElement | null): number | null {
  try {
    const win = frame?.contentWindow as (Window & { UI?: unknown; rfb?: unknown }) | null | undefined;
    const rfb = objectRecord(objectRecord(win?.UI)?.rfb) || objectRecord(win?.rfb);
    const sock = objectRecord(rfb?._sock);
    const websocket = objectRecord(sock?._websocket) || objectRecord(sock?._webSocket)
      || objectRecord(sock?.websocket) || objectRecord(sock?.webSocket)
      || objectRecord(sock?._ws) || objectRecord(sock?.ws)
      || objectRecord(rfb?._websocket) || objectRecord(rfb?._webSocket);
    const bufferedAmount = websocket?.bufferedAmount;
    return typeof bufferedAmount === 'number' && Number.isFinite(bufferedAmount) ? Math.max(0, bufferedAmount) : null;
  } catch {
    return null;
  }
}

function sizeOrNull(width: number | undefined, height: number | undefined): VncFrameResolution | null {
  const roundedWidth = Math.round(width || 0);
  const roundedHeight = Math.round(height || 0);
  if (roundedWidth <= 0 || roundedHeight <= 0) return null;
  return { width: roundedWidth, height: roundedHeight };
}

function calculateScalePercent(
  resolution: VncFrameResolution | null,
  viewport: VncFrameResolution | null,
): number | null {
  if (!resolution || !viewport) return null;
  if (resolution.width <= 0 || resolution.height <= 0) return null;
  const scale = Math.min(viewport.width / resolution.width, viewport.height / resolution.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return Math.round(scale * 100);
}

function calculateJitter(samples: number[]): number {
  let total = 0;
  for (let i = 1; i < samples.length; i += 1) {
    total += Math.abs(samples[i] - samples[i - 1]);
  }
  return Math.round(total / (samples.length - 1));
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function sameRuntimeStats(
  current: VncPerformanceStats,
  next: Pick<
    VncPerformanceStats,
    'resolution' | 'viewport' | 'scalePercent' | 'devicePixelRatio' | 'heapUsedBytes' | 'websocketBufferedBytes'
  >,
): boolean {
  return (
    sameResolution(current.resolution, next.resolution)
    && sameResolution(current.viewport, next.viewport)
    && current.scalePercent === next.scalePercent
    && current.devicePixelRatio === next.devicePixelRatio
    && current.heapUsedBytes === next.heapUsedBytes
    && current.websocketBufferedBytes === next.websocketBufferedBytes
  );
}

function sameResolution(a: VncFrameResolution | null, b: VncFrameResolution | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.width === b.width && a.height === b.height;
}
