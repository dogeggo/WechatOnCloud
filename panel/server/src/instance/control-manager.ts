import type { AuthUser } from '../auth/auth-manager.js';

const CONTROL_TTL_MS = 10_000;

interface ControlHolder {
  sub: string;
  username: string;
  at: number;
}

export interface ControlClaim {
  ok: boolean;
  holder: string;
}

export class ControlManager {
  private readonly holders = new Map<string, ControlHolder>();

  claimForAction(instanceId: string, user: AuthUser): ControlClaim {
    const now = Date.now();
    const holder = this.holders.get(instanceId);
    if (!holder || now - holder.at > CONTROL_TTL_MS || holder.sub === user.sub) {
      this.holders.set(instanceId, { sub: user.sub, username: user.username, at: now });
      return { ok: true, holder: user.username };
    }
    return { ok: false, holder: holder.username };
  }

  status(instanceId: string, user: AuthUser) {
    const holder = this.holders.get(instanceId);
    if (!holder || Date.now() - holder.at > CONTROL_TTL_MS) {
      return { free: true, mine: false, holder: null };
    }
    return { free: false, mine: holder.sub === user.sub, holder: holder.username };
  }

  take(instanceId: string, user: AuthUser) {
    this.holders.set(instanceId, { sub: user.sub, username: user.username, at: Date.now() });
    return { mine: true, holder: user.username };
  }

  release(instanceId: string): void {
    this.holders.delete(instanceId);
  }

  hasActiveSession(instanceId: string): boolean {
    const holder = this.holders.get(instanceId);
    return !!holder && Date.now() - holder.at <= CONTROL_TTL_MS;
  }
}
