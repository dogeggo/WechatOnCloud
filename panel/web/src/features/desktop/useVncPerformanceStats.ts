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
const FPS_SAMPLE_WIDTH = 48;
const FPS_SAMPLE_HEIGHT = 27;
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
    let changedFrames = 0;
    let sampleSeen = false;
    let lastFingerprint: number | null = null;
    let sampleStartedAt = performance.now();
    let rafId = 0;
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = FPS_SAMPLE_WIDTH;
    sampleCanvas.height = FPS_SAMPLE_HEIGHT;
    const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });

    const tick = (now: number) => {
      if (stopped) return;

      const fingerprint = sampleContext
        ? readCanvasFingerprint(frameRef.current, sampleCanvas, sampleContext)
        : null;
      if (fingerprint !== null) {
        sampleSeen = true;
        if (lastFingerprint !== null && fingerprint !== lastFingerprint) changedFrames += 1;
        lastFingerprint = fingerprint;
      }

      const elapsed = now - sampleStartedAt;
      if (elapsed >= 1000) {
        const fps = sampleSeen ? Math.max(0, Math.round((changedFrames * 1000) / elapsed)) : null;
        const frameIntervalMs = fps && fps > 0 ? Math.round(1000 / fps) : null;
        setStats((current) =>
          current.fps === fps && current.frameIntervalMs === frameIntervalMs
            ? current
            : { ...current, fps, frameIntervalMs },
        );
        changedFrames = 0;
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

      if (!stopped) timer = window.setTimeout(measureLatency, 3000);
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

function readFrameGeometry(frame: HTMLIFrameElement | null): Pick<
  VncPerformanceStats,
  'resolution' | 'viewport' | 'scalePercent'
> {
  try {
    const doc = frame?.contentDocument;
    const canvas = doc?.querySelector('canvas') as HTMLCanvasElement | null;
    const resolution = sizeOrNull(canvas?.width, canvas?.height)
      || sizeOrNull(doc?.documentElement.clientWidth, doc?.documentElement.clientHeight)
      || sizeOrNull(frame?.clientWidth, frame?.clientHeight);
    const canvasRect = canvas?.getBoundingClientRect();
    const viewport = sizeOrNull(canvasRect?.width, canvasRect?.height)
      || sizeOrNull(frame?.clientWidth, frame?.clientHeight);
    return {
      resolution,
      viewport,
      scalePercent: calculateScalePercent(resolution, viewport),
    };
  } catch {
    const viewport = sizeOrNull(frame?.clientWidth, frame?.clientHeight);
    return {
      resolution: viewport,
      viewport,
      scalePercent: 100,
    };
  }
}

function readCanvasFingerprint(
  frame: HTMLIFrameElement | null,
  sampleCanvas: HTMLCanvasElement,
  sampleContext: CanvasRenderingContext2D,
): number | null {
  try {
    const canvas = frame?.contentDocument?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;

    sampleContext.drawImage(canvas, 0, 0, sampleCanvas.width, sampleCanvas.height);
    const data = sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
    let hash = 2166136261;
    hash = Math.imul(hash ^ canvas.width, 16777619);
    hash = Math.imul(hash ^ canvas.height, 16777619);
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ data[i], 16777619);
      hash = Math.imul(hash ^ data[i + 1], 16777619);
      hash = Math.imul(hash ^ data[i + 2], 16777619);
    }
    return hash >>> 0;
  } catch {
    return null;
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
      || objectRecord(sock?.websocket) || objectRecord(sock?.webSocket);
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
