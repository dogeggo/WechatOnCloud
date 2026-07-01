import { useEffect, useState, type RefObject } from 'react';
import { api, type AppMetricsEvent } from '../../api';

export interface VncFrameResolution {
  width: number;
  height: number;
}

export interface VncPerformanceStats {
  latencyMs: number | null;
  latencyJitterMs: number | null;
  fps: number | null;
  resolution: VncFrameResolution | null;
  viewport: VncFrameResolution | null;
  scalePercent: number | null;
  appMemoryUsedBytes: number | null;
  appMemoryMaxBytes: number | null;
  appCpuPercent: number | null;
}

const EMPTY_STATS: VncPerformanceStats = {
  latencyMs: null,
  latencyJitterMs: null,
  fps: null,
  resolution: null,
  viewport: null,
  scalePercent: null,
  appMemoryUsedBytes: null,
  appMemoryMaxBytes: null,
  appCpuPercent: null,
};
const LATENCY_SAMPLE_SIZE = 6;

export function useVncPerformanceStats({
  active,
  showVnc,
  frameLoaded,
  frameRef,
  instanceId,
}: {
  active: boolean;
  showVnc: boolean;
  frameLoaded: boolean;
  frameRef: RefObject<HTMLIFrameElement>;
  instanceId: string | undefined;
}): VncPerformanceStats {
  const [stats, setStats] = useState<VncPerformanceStats>(EMPTY_STATS);
  const enabled = active && showVnc && frameLoaded;
  const metricsEnabled = enabled && !!instanceId;

  useEffect(() => {
    if (enabled) return;
    setStats(EMPTY_STATS);
  }, [enabled]);

  useEffect(() => {
    if (metricsEnabled) return;
    setStats((current) =>
      current.appMemoryUsedBytes === null
        && current.appMemoryMaxBytes === null
        && current.appCpuPercent === null
        ? current
        : {
          ...current,
          appMemoryUsedBytes: null,
          appMemoryMaxBytes: null,
          appCpuPercent: null,
        },
    );
  }, [metricsEnabled]);

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
        setStats((current) =>
          current.fps === fps
            ? current
            : { ...current, fps },
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
          current.latencyMs === latencyMs
            && current.latencyJitterMs === latencyJitterMs
            ? current
            : { ...current, latencyMs, latencyJitterMs },
        );
      } catch {
        if (!stopped) {
          setStats((current) =>
            current.latencyMs === null
              && current.latencyJitterMs === null
              ? current
              : {
                ...current,
                latencyMs: null,
                latencyJitterMs: null,
              },
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

  useEffect(() => {
    if (!metricsEnabled) return;
    const currentInstanceId = instanceId;
    if (!currentInstanceId) return;

    let stream: EventSource | null = null;

    const clearAppMetrics = () => {
      setStats((current) =>
        current.appMemoryUsedBytes === null
          && current.appMemoryMaxBytes === null
          && current.appCpuPercent === null
          ? current
          : {
            ...current,
            appMemoryUsedBytes: null,
            appMemoryMaxBytes: null,
            appCpuPercent: null,
          },
      );
    };

    const onMetrics = (event: MessageEvent) => {
      try {
        const metrics = JSON.parse(event.data) as AppMetricsEvent;
        if (metrics?.type !== 'performance-metrics') return;
        const appMemoryUsedBytes = normalizeMetricNumber(metrics.usedBytes);
        const appMemoryMaxBytes = normalizeMetricNumber(metrics.maxBytes);
        const appCpuPercent = normalizeMetricNumber(metrics.cpuPercent);
        setStats((current) =>
          current.appMemoryUsedBytes === appMemoryUsedBytes
            && current.appMemoryMaxBytes === appMemoryMaxBytes
            && current.appCpuPercent === appCpuPercent
            ? current
            : { ...current, appMemoryUsedBytes, appMemoryMaxBytes, appCpuPercent },
        );
      } catch {
        /* ignore malformed metrics event */
      }
    };

    stream = new EventSource(api.instanceMetricsStreamUrl(currentInstanceId));
    stream.addEventListener('metrics', onMetrics as EventListener);
    stream.onerror = clearAppMetrics;

    return () => {
      if (!stream) return;
      stream.removeEventListener('metrics', onMetrics as EventListener);
      stream.onerror = null;
      stream.close();
      stream = null;
    };
  }, [metricsEnabled, instanceId]);

  return stats;
}

function readRuntimeStats(frame: HTMLIFrameElement | null): Pick<
  VncPerformanceStats,
  'resolution' | 'viewport' | 'scalePercent'
> {
  return readFrameGeometry(frame);
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

function normalizeMetricNumber(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sameRuntimeStats(
  current: VncPerformanceStats,
  next: Pick<
    VncPerformanceStats,
    'resolution' | 'viewport' | 'scalePercent'
  >,
): boolean {
  return (
    sameResolution(current.resolution, next.resolution)
    && sameResolution(current.viewport, next.viewport)
    && current.scalePercent === next.scalePercent
  );
}

function sameResolution(a: VncFrameResolution | null, b: VncFrameResolution | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.width === b.width && a.height === b.height;
}
