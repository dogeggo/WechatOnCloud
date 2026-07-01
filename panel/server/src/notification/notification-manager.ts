import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, httpError } from '../http/http-error.js';
import { SseClientHub } from '../http/sse-stream.js';
import { canAccessInstance, type Instance, type InstanceActor } from '../instance/store.js';

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

export interface ExternalLinkEvent {
  type: 'external-link';
  id: string;
  instanceId: string;
  instanceName: string;
  appType: Instance['appType'];
  appName: string;
  url: string;
  createdAt: number;
}

export interface NotificationStreamOptions {
  externalLinksEnabled: boolean;
  browserClientId: string;
}

interface NotificationClientMeta {
  actor: InstanceActor;
  externalLinksEnabled: boolean;
  browserClientId: string;
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
  telegram: 'Telegram',
  chromium: 'Chromium',
};

export class NotificationManager {
  private clients = new SseClientHub<NotificationClientMeta>();
  private eventSeq = 0;

  openStream(
    req: FastifyRequest,
    reply: FastifyReply,
    actor: InstanceActor,
    options: NotificationStreamOptions,
  ): void {
    this.clients.open(req, reply, {
      actor,
      externalLinksEnabled: options.externalLinksEnabled,
      browserClientId: options.browserClientId,
    });
  }

  receive(inst: Instance, authorization: string | undefined, payload: unknown): InstanceNotificationEvent {
    this.verifyToken(inst, authorization);
    const event = this.normalizeEvent(inst, payload);
    this.broadcastForInstance(inst, 'notification', event.id, event);
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
    this.broadcastForInstance(inst, 'desktop-client-replaced', event.id, event);
    return event;
  }

  receiveExternalLink(
    inst: Instance,
    authorization: string | undefined,
    payload: unknown,
    browserClientId: string | null,
  ): { event: ExternalLinkEvent; accepted: boolean } {
    this.verifyToken(inst, authorization);
    const event = this.normalizeExternalLinkEvent(inst, payload);
    return { event, accepted: this.sendExternalLink(inst, event, browserClientId) };
  }

  private broadcastForInstance(inst: Instance, eventName: string, id: string, data: unknown): void {
    for (const client of this.clients.all()) {
      if (!canAccessInstance(inst, client.meta.actor)) continue;
      this.clients.send(client, eventName, id, data);
    }
  }

  private sendExternalLink(inst: Instance, event: ExternalLinkEvent, browserClientId: string | null): boolean {
    if (!browserClientId) return false;
    for (const client of this.clients.all()) {
      if (!client.meta.externalLinksEnabled || !canAccessInstance(inst, client.meta.actor)) continue;
      if (client.meta.browserClientId !== browserClientId) continue;
      if (this.clients.send(client, 'external-link', event.id, event)) return true;
    }
    return false;
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

  private normalizeExternalLinkEvent(inst: Instance, payload: unknown): ExternalLinkEvent {
    if (!payload || typeof payload !== 'object') throw httpError(400, '外链内容格式不合法');
    const raw = payload as Record<string, unknown>;
    const appName = APP_LABELS[inst.appType];
    return {
      type: 'external-link',
      id: `${inst.id}-link-${Date.now().toString(36)}-${++this.eventSeq}`,
      instanceId: inst.id,
      instanceName: inst.name,
      appType: inst.appType,
      appName,
      url: normalizeExternalHttpUrl(raw.url),
      createdAt: Date.now(),
    };
  }
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

function normalizeExternalHttpUrl(value: unknown): string {
  if (typeof value !== 'string') throw httpError(400, '外链地址格式不合法');
  const raw = value.trim();
  if (!raw || raw.length > 2048) throw httpError(400, '外链地址为空或过长');
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw httpError(400, '只支持 http/https 外链');
    }
    return url.toString();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw httpError(400, '外链地址格式不合法');
  }
}
