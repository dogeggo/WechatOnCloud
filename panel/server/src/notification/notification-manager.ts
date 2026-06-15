import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import { httpError } from '../http/http-error.js';
import type { Instance } from '../instance/store.js';

export interface InstanceNotificationEvent {
  type: 'instance-notification';
  id: string;
  instanceId: string;
  instanceName: string;
  appType: Instance['appType'];
  appName: string;
  title: string;
  body: string;
  urgency: 'low' | 'normal' | 'critical';
  source: string;
  createdAt: number;
}

export interface DesktopClientReplacedEvent {
  type: 'desktop-client-replaced';
  id: string;
  clientId: string;
  instanceId: string;
  instanceName: string;
  appType: Instance['appType'];
  appName: string;
  title: string;
  body: string;
  createdAt: number;
}

interface Client {
  id: number;
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
}

const MAX_TEXT = {
  appName: 40,
  title: 120,
  body: 500,
  source: 40,
};

const APP_LABELS: Record<Instance['appType'], string> = {
  wechat: '微信',
  qq: 'QQ',
  chromium: 'Chromium',
};

export class NotificationManager {
  private clients = new Map<number, Client>();
  private clientSeq = 0;
  private eventSeq = 0;

  openStream(req: FastifyRequest, reply: FastifyReply): void {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    const clientId = ++this.clientSeq;
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(`: ping ${Date.now()}\n\n`);
    }, 25_000);
    const client: Client = { id: clientId, res, heartbeat };
    this.clients.set(clientId, client);

    const close = () => this.closeClient(clientId);
    req.raw.once('close', close);
    res.once('close', close);
    res.once('error', close);
  }

  receive(inst: Instance, authorization: string | undefined, payload: unknown): InstanceNotificationEvent {
    this.verifyToken(inst, authorization);
    const event = this.normalizeEvent(inst, payload);
    this.broadcast('notification', event.id, event);
    return event;
  }

  desktopClientReplaced(inst: Instance, clientId: string): DesktopClientReplacedEvent {
    const appName = APP_LABELS[inst.appType];
    const event: DesktopClientReplacedEvent = {
      type: 'desktop-client-replaced',
      id: `${inst.id}-desktop-${Date.now().toString(36)}-${++this.eventSeq}`,
      clientId,
      instanceId: inst.id,
      instanceName: inst.name,
      appType: inst.appType,
      appName,
      title: `${appName}连接已断开`,
      body: '同一个应用只能保留一个客户端连接，新客户端已接入。',
      createdAt: Date.now(),
    };
    this.broadcast('desktop-client-replaced', event.id, event);
    return event;
  }

  private closeClient(id: number): void {
    const client = this.clients.get(id);
    if (!client) return;
    clearInterval(client.heartbeat);
    this.clients.delete(id);
    try {
      if (!client.res.destroyed) client.res.end();
    } catch {
      /* ignore closed SSE client */
    }
  }

  private broadcast(eventName: string, id: string, data: unknown): void {
    const message = sseMessage(eventName, id, data);
    for (const client of this.clients.values()) {
      if (client.res.destroyed) {
        this.closeClient(client.id);
        continue;
      }
      try {
        client.res.write(message);
      } catch {
        this.closeClient(client.id);
      }
    }
  }

  private verifyToken(inst: Instance, authorization: string | undefined): void {
    const token = bearerToken(authorization);
    if (!token || !constantTimeEqual(token, inst.kasmPassword)) {
      throw httpError(401, '通知上报密钥不正确');
    }
  }

  private normalizeEvent(inst: Instance, payload: unknown): InstanceNotificationEvent {
    if (!payload || typeof payload !== 'object') throw httpError(400, '通知内容格式不合法');
    const raw = payload as Record<string, unknown>;
    const appName = sanitizeText(raw.appName, MAX_TEXT.appName) || APP_LABELS[inst.appType];
    const summary = sanitizeText(raw.summary ?? raw.title, MAX_TEXT.title);
    const body = sanitizeText(raw.body, MAX_TEXT.body);
    const title = summary || appName || APP_LABELS[inst.appType];
    const source = sanitizeText(raw.source, MAX_TEXT.source) || 'dbus';
    const urgency = normalizeUrgency(raw.urgency);
    return {
      type: 'instance-notification',
      id: `${inst.id}-${Date.now().toString(36)}-${++this.eventSeq}`,
      instanceId: inst.id,
      instanceName: inst.name,
      appType: inst.appType,
      appName,
      title,
      body,
      urgency,
      source,
      createdAt: Date.now(),
    };
  }
}

function sseMessage(eventName: string, id: string, data: unknown): string {
  return [
    `id: ${id}`,
    `event: ${eventName}`,
    `data: ${JSON.stringify(data)}`,
    '',
    '',
  ].join('\n');
}

function bearerToken(value: string | undefined): string {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/\0/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeUrgency(value: unknown): InstanceNotificationEvent['urgency'] {
  const raw = typeof value === 'number' ? value : Number(value);
  if (raw === 0) return 'low';
  if (raw === 2) return 'critical';
  return 'normal';
}
