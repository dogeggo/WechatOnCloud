import type { FastifyBaseLogger } from 'fastify';
import type { Socket } from 'node:net';
import type { Instance } from '../instance/store.js';
import type { NotificationManager } from '../notification/notification-manager.js';

const DISPLACED_CLIENT_TTL_MS = 60_000;

interface DesktopClientConnection {
  instanceId: string;
  clientId: string;
  browserClientId: string;
  socket: Socket;
}

interface RegisterDesktopClientOptions {
  inst: Instance;
  clientId: string;
  browserClientId: string;
  socket: Socket;
  notifications: NotificationManager;
  log: FastifyBaseLogger;
}

export class DesktopClientManager {
  private readonly active = new Map<string, DesktopClientConnection>();
  private readonly displacedUntil = new Map<string, number>();

  register({ inst, clientId, browserClientId, socket, notifications, log }: RegisterDesktopClientOptions): boolean {
    this.pruneDisplaced();

    const active = this.active.get(inst.id);
    if (active && active.clientId !== clientId && this.isDisplaced(inst.id, clientId)) {
      notifications.desktopClientReplaced(inst, clientId);
      socket.destroy();
      return false;
    }

    if (active && active.socket !== socket) {
      if (active.clientId !== clientId) {
        this.markDisplaced(inst.id, active.clientId);
        notifications.desktopClientReplaced(inst, active.clientId);
        log.info(`[desktop] ${inst.id} 新客户端接入，已断开旧客户端`);
      }
      active.socket.destroy();
    }

    const current: DesktopClientConnection = { instanceId: inst.id, clientId, browserClientId, socket };
    this.active.set(inst.id, current);
    socket.once('close', () => this.release(current));
    return true;
  }

  releaseInstance(instanceId: string): void {
    const active = this.active.get(instanceId);
    this.active.delete(instanceId);
    if (active && !active.socket.destroyed) active.socket.destroy();
  }

  hasActiveSession(instanceId: string): boolean {
    const active = this.active.get(instanceId);
    if (!active) return false;
    if (active.socket.destroyed) {
      this.active.delete(instanceId);
      return false;
    }
    return true;
  }

  activeBrowserClientId(instanceId: string): string | null {
    const active = this.active.get(instanceId);
    if (!active) return null;
    if (active.socket.destroyed) {
      this.active.delete(instanceId);
      return null;
    }
    return active.browserClientId || null;
  }

  private release(client: DesktopClientConnection): void {
    const active = this.active.get(client.instanceId);
    if (active?.socket === client.socket) this.active.delete(client.instanceId);
  }

  private displacedKey(instanceId: string, clientId: string): string {
    return `${instanceId}:${clientId}`;
  }

  private markDisplaced(instanceId: string, clientId: string): void {
    this.displacedUntil.set(this.displacedKey(instanceId, clientId), Date.now() + DISPLACED_CLIENT_TTL_MS);
  }

  private isDisplaced(instanceId: string, clientId: string): boolean {
    const key = this.displacedKey(instanceId, clientId);
    const until = this.displacedUntil.get(key);
    if (!until) return false;
    if (until <= Date.now()) {
      this.displacedUntil.delete(key);
      return false;
    }
    return true;
  }

  private pruneDisplaced(): void {
    const now = Date.now();
    for (const [key, until] of this.displacedUntil) {
      if (until <= now) this.displacedUntil.delete(key);
    }
  }
}
