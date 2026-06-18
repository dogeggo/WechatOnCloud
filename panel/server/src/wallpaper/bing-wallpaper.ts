import { httpError } from '../http/http-error.js';

export interface LoginWallpaper {
  imageUrl: string;
  title: string;
  copyright: string;
  copyrightLink: string;
  fetchedAt: number;
}

type BingImagePayload = {
  images?: unknown;
};

const BING_ORIGIN = 'https://www.bing.com';
const BING_WALLPAPER_URL = `${BING_ORIGIN}/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN`;
const WALLPAPER_CACHE_MS = 6 * 60 * 60 * 1000;
const WALLPAPER_FETCH_TIMEOUT_MS = 5000;

export class BingWallpaperManager {
  private cache: { wallpaper: LoginWallpaper; expiresAt: number } | null = null;

  async current(): Promise<LoginWallpaper> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.wallpaper;

    const payload = await fetchBingWallpaperPayload();
    const wallpaper = normalizeWallpaper(payload, now);
    this.cache = { wallpaper, expiresAt: now + WALLPAPER_CACHE_MS };
    return wallpaper;
  }
}

async function fetchBingWallpaperPayload(): Promise<BingImagePayload> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WALLPAPER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(BING_WALLPAPER_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw httpError(502, `读取必应壁纸失败 (${response.status})`);
    return (await response.json()) as BingImagePayload;
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') {
      throw httpError(504, '读取必应壁纸超时');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeWallpaper(payload: BingImagePayload, fetchedAt: number): LoginWallpaper {
  const image = Array.isArray(payload.images) ? payload.images[0] : null;
  if (!image || typeof image !== 'object') throw httpError(502, '必应壁纸响应格式不正确');

  const record = image as Record<string, unknown>;
  const imageUrl = normalizeBingUrl(textField(record.url));
  const copyrightLink = normalizeOptionalBingUrl(textField(record.copyrightlink));

  return {
    imageUrl,
    title: textField(record.title),
    copyright: textField(record.copyright),
    copyrightLink,
    fetchedAt,
  };
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBingUrl(value: string): string {
  if (!value) throw httpError(502, '必应壁纸地址为空');
  const url = new URL(value, BING_ORIGIN);
  if (url.protocol !== 'https:' || !isBingHost(url.hostname)) {
    throw httpError(502, '必应壁纸地址不合法');
  }
  return url.toString();
}

function normalizeOptionalBingUrl(value: string): string {
  if (!value) return '';
  return normalizeBingUrl(value);
}

function isBingHost(hostname: string): boolean {
  return hostname === 'bing.com' || hostname.endsWith('.bing.com');
}
