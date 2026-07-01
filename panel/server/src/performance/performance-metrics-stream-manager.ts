import type { FastifyReply, FastifyRequest } from 'fastify';
import { SseClientHub, type SseClient } from '../http/sse-stream.js';
import type { InstanceActor } from '../instance/store.js';
import type { ApplicationMetricsInfo, InstanceManager } from '../instance/instance-manager.js';

interface PerformanceMetricsClientMeta {
  actor: InstanceActor;
  instanceId: string;
}

interface PerformanceMetricsStreamClient {
  sse: SseClient<PerformanceMetricsClientMeta>;
  pingTimer: NodeJS.Timeout;
  metricsTimer: NodeJS.Timeout;
  metricsRunning: boolean;
  eventSeq: number;
}

export interface PerformancePingEvent {
  type: 'performance-ping';
  serverTime: number;
}

export interface PerformanceMetricsEvent extends ApplicationMetricsInfo {
  type: 'performance-metrics';
  serverTime: number;
}

const METRICS_INTERVAL_MS = 10_000;
const PING_INTERVAL_MS = 5_000;
const SSE_KEEPALIVE_MS = 25_000;

export class PerformanceMetricsStreamManager {
  private readonly clients = new SseClientHub<PerformanceMetricsClientMeta>(SSE_KEEPALIVE_MS);
  private readonly streams = new Map<number, PerformanceMetricsStreamClient>();

  constructor(private readonly instances: InstanceManager) {}

  openStream(
    req: FastifyRequest,
    reply: FastifyReply,
    actor: InstanceActor,
    instanceId: unknown,
  ): void {
    const inst = this.instances.requireInstanceForActor(instanceId, actor);
    let stream!: PerformanceMetricsStreamClient;
    const sse = this.clients.open(
      req,
      reply,
      { actor, instanceId: inst.id },
      {
        onClose: (client) => {
          this.cleanupStream(client.id);
        },
      },
    );

    stream = {
      sse,
      pingTimer: setTimeout(() => this.ping(stream), 0),
      metricsTimer: setTimeout(() => this.syncMetrics(stream), 0),
      metricsRunning: false,
      eventSeq: 0,
    };
    this.streams.set(sse.id, stream);
  }

  private ping(stream: PerformanceMetricsStreamClient): void {
    if (!this.sendPing(stream)) {
      this.cleanupStream(stream.sse.id);
      return;
    }
    this.schedulePing(stream);
  }

  private syncMetrics(stream: PerformanceMetricsStreamClient): void {
    if (stream.metricsRunning) {
      this.scheduleMetrics(stream);
      return;
    }

    stream.metricsRunning = true;

    this.instances.applicationMetrics(stream.sse.meta.actor, stream.sse.meta.instanceId)
      .then((metrics) => {
        const event: PerformanceMetricsEvent = {
          type: 'performance-metrics',
          ...metrics,
          serverTime: Date.now(),
        };
        if (!this.clients.send(stream.sse, 'metrics', this.nextEventId(stream, 'metrics'), event)) {
          this.cleanupStream(stream.sse.id);
        }
      })
      .catch(() => {
        this.clients.close(stream.sse);
      })
      .finally(() => {
        stream.metricsRunning = false;
        this.scheduleMetrics(stream);
      });
  }

  private schedulePing(stream: PerformanceMetricsStreamClient): void {
    if (!this.streams.has(stream.sse.id)) return;
    stream.pingTimer = setTimeout(() => this.ping(stream), PING_INTERVAL_MS);
  }

  private scheduleMetrics(stream: PerformanceMetricsStreamClient): void {
    if (!this.streams.has(stream.sse.id)) return;
    stream.metricsTimer = setTimeout(() => this.syncMetrics(stream), METRICS_INTERVAL_MS);
  }

  private sendPing(stream: PerformanceMetricsStreamClient, serverTime = Date.now()): boolean {
    const event: PerformancePingEvent = {
      type: 'performance-ping',
      serverTime,
    };
    return this.clients.send(stream.sse, 'ping', this.nextEventId(stream, 'ping'), event);
  }

  private cleanupStream(clientId: number): void {
    const stream = this.streams.get(clientId);
    if (!stream) return;
    clearTimeout(stream.pingTimer);
    clearTimeout(stream.metricsTimer);
    this.streams.delete(clientId);
  }

  private nextEventId(stream: PerformanceMetricsStreamClient, type: string): string {
    stream.eventSeq += 1;
    return `${stream.sse.meta.instanceId}-${type}-${Date.now().toString(36)}-${stream.eventSeq}`;
  }
}
