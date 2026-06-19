import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllowedHosts, parseTrustedProxies, type TrustedProxy } from '../http/host-guard.js';
import { MIB, instanceMemoryLimitMB } from './instance-memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export { MIB };

export interface UploadLimits {
  transferBytes: number;
  transferDownloadBytes: number;
  volumeFileBytes: number;
  volumeFileDownloadBytes: number;
  volumeArchiveBytes: number;
  volumeArchiveExtractedBytes: number;
}

export interface RateLimitConfig {
  windowMs: number;
  apiPerMinute: number;
  authPerMinute: number;
}

export interface WatchdogConfig {
  defaultSoftMB: number;
  defaultHardMB: number;
  hardMaxMB: number;
  intervalSec: number;
  enabled: boolean;
}

export interface PanelConfig {
  port: number;
  host: string;
  staticDir: string;
  sessionCookieName: string;
  flowCookieName: string;
  allowedHosts: string[];
  trustedProxies: TrustedProxy[];
  upload: UploadLimits;
  rateLimit: RateLimitConfig;
  watchdog: WatchdogConfig;
}

export function envInt(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw == null || raw.trim() === '' ? defaultValue : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 之间的整数`);
  }
  return n;
}

const defaultSoftMB = envInt('WOC_INSTANCE_MEM_SOFT_MB', 1500, 0, 20480);
const defaultHardMB = envInt('WOC_INSTANCE_MEM_HARD_MB', 2500, 0, 20480);
const watchdogIntervalSec = envInt('WOC_WATCHDOG_INTERVAL_SEC', 300, 0, 86400);

if (defaultSoftMB > 0 && defaultHardMB > 0 && defaultSoftMB >= defaultHardMB) {
  throw new Error('WOC_INSTANCE_MEM_SOFT_MB 必须小于 WOC_INSTANCE_MEM_HARD_MB');
}
if (instanceMemoryLimitMB > 0 && defaultHardMB > instanceMemoryLimitMB) {
  throw new Error(
    `WOC_INSTANCE_MEM_HARD_MB 不能超过 WOC_INSTANCE_MEM_GB 对应的 ${instanceMemoryLimitMB} MiB`,
  );
}

export const panelConfig: PanelConfig = {
  port: envInt('PORT', 8080, 1, 65535),
  host: process.env.HOST || '0.0.0.0',
  staticDir: process.env.STATIC_DIR || join(__dirname, '../../web/dist'),
  sessionCookieName: 'woc_sess',
  flowCookieName: 'woc_oidc',
  allowedHosts: parseAllowedHosts(process.env.PANEL_ALLOWED_HOSTS),
  trustedProxies: parseTrustedProxies(process.env.PANEL_TRUSTED_PROXIES),
  upload: {
    transferBytes: envInt('PANEL_MAX_TRANSFER_UPLOAD_MB', 128, 1, 512) * MIB,
    transferDownloadBytes: envInt('PANEL_MAX_TRANSFER_DOWNLOAD_MB', 128, 1, 512) * MIB,
    volumeFileBytes: envInt('PANEL_MAX_VOLUME_FILE_UPLOAD_MB', 256, 1, 1024) * MIB,
    volumeFileDownloadBytes: envInt('PANEL_MAX_VOLUME_FILE_DOWNLOAD_MB', 256, 1, 1024) * MIB,
    volumeArchiveBytes: envInt('PANEL_MAX_VOLUME_ARCHIVE_UPLOAD_MB', 512, 1, 3072) * MIB,
    volumeArchiveExtractedBytes: envInt('PANEL_MAX_VOLUME_ARCHIVE_EXTRACTED_MB', 1024, 1, 8192) * MIB,
  },
  rateLimit: {
    windowMs: 60_000,
    apiPerMinute: envInt('PANEL_RATE_LIMIT_API_PER_MIN', 600, 10, 10000),
    authPerMinute: envInt('PANEL_RATE_LIMIT_AUTH_PER_MIN', 30, 5, 1000),
  },
  watchdog: {
    defaultSoftMB,
    defaultHardMB,
    hardMaxMB: instanceMemoryLimitMB,
    intervalSec: watchdogIntervalSec,
    enabled: watchdogIntervalSec > 0 && (defaultSoftMB > 0 || defaultHardMB > 0),
  },
};
