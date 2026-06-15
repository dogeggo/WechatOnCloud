import type { RateLimitConfig } from '../config/panel-config.js';

interface RateBucket {
  start: number;
  count: number;
}

type RateLimitGroup = 'auth' | 'api';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
}

function rateLimitGroup(path: string): RateLimitGroup | null {
  if (path.startsWith('/api/auth/')) return 'auth';
  if (path.startsWith('/api/') || path.startsWith('/desktop/')) return 'api';
  return null;
}

export class RateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  constructor(private readonly config: RateLimitConfig) {}

  consume(path: string, ip: string, now = Date.now()): RateLimitResult {
    const group = rateLimitGroup(path);
    if (!group) return { allowed: true };

    const limit = group === 'auth' ? this.config.authPerMinute : this.config.apiPerMinute;
    const key = `${group}:${ip}`;
    this.pruneIfNeeded(now);

    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.config.windowMs) {
      this.buckets.set(key, { start: now, count: 1 });
      return { allowed: true };
    }

    bucket.count += 1;
    if (bucket.count <= limit) return { allowed: true };

    return {
      allowed: false,
      retryAfterSec: Math.ceil((this.config.windowMs - (now - bucket.start)) / 1000),
    };
  }

  private pruneIfNeeded(now: number): void {
    if (this.buckets.size <= 10_000) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.start >= this.config.windowMs) this.buckets.delete(key);
    }
  }
}
