export type VncStreamProfile = 'speed' | 'balanced' | 'quality';

export interface VncStreamSettings {
  profile: VncStreamProfile;
  quality: number;
  compression: number;
  dynamicQualityMin: number;
  dynamicQualityMax: number;
  treatLossless: number;
  jpegVideoQuality: number;
  webpVideoQuality: number;
  videoQuality: number;
  videoArea: number;
  videoTime: number;
  videoOutTime: number;
  videoScaling: number;
  maxVideoResolutionX: number;
  maxVideoResolutionY: number;
  frameRate: number;
  enableWebP: boolean;
  audio: boolean;
}

export interface VncStreamProfileOption {
  profile: VncStreamProfile;
  label: string;
  title: string;
  settings: VncStreamSettings;
}

const VNC_STREAM_SETTINGS_KEY = 'woc_vnc_stream_settings';

export const VNC_STREAM_PROFILES: VncStreamProfileOption[] = [
  {
    profile: 'speed',
    label: '省流',
    title: '降低画质并提高压缩，关闭音频流',
    settings: {
      profile: 'speed',
      quality: 4,
      compression: 8,
      dynamicQualityMin: 3,
      dynamicQualityMax: 6,
      treatLossless: 7,
      jpegVideoQuality: 4,
      webpVideoQuality: 4,
      videoQuality: 10,
      videoArea: 45,
      videoTime: 3,
      videoOutTime: 2,
      videoScaling: 0,
      maxVideoResolutionX: 960,
      maxVideoResolutionY: 540,
      frameRate: 15,
      enableWebP: true,
      audio: false,
    },
  },
  {
    profile: 'balanced',
    label: '均衡',
    title: '日常使用，兼顾清晰度和流量',
    settings: {
      profile: 'balanced',
      quality: 5,
      compression: 7,
      dynamicQualityMin: 4,
      dynamicQualityMax: 8,
      treatLossless: 8,
      jpegVideoQuality: 6,
      webpVideoQuality: 6,
      videoQuality: 10,
      videoArea: 55,
      videoTime: 5,
      videoOutTime: 3,
      videoScaling: 0,
      maxVideoResolutionX: 1280,
      maxVideoResolutionY: 720,
      frameRate: 24,
      enableWebP: true,
      audio: true,
    },
  },
  {
    profile: 'quality',
    label: '清晰',
    title: '提高画质，适合网络较稳定时使用',
    settings: {
      profile: 'quality',
      quality: 8,
      compression: 4,
      dynamicQualityMin: 7,
      dynamicQualityMax: 9,
      treatLossless: 9,
      jpegVideoQuality: 8,
      webpVideoQuality: 8,
      videoQuality: 10,
      videoArea: 65,
      videoTime: 5,
      videoOutTime: 3,
      videoScaling: 0,
      maxVideoResolutionX: 1920,
      maxVideoResolutionY: 1080,
      frameRate: 30,
      enableWebP: true,
      audio: true,
    },
  },
];

export const DEFAULT_VNC_STREAM_SETTINGS = VNC_STREAM_PROFILES[1].settings;

const PROFILE_BY_ID = new Map(VNC_STREAM_PROFILES.map((option) => [option.profile, option]));

export function readVncStreamSettings(): VncStreamSettings {
  try {
    const raw = window.localStorage.getItem(VNC_STREAM_SETTINGS_KEY);
    if (!raw) return DEFAULT_VNC_STREAM_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<VncStreamSettings>;
    return normalizeVncStreamSettings(parsed);
  } catch {
    return DEFAULT_VNC_STREAM_SETTINGS;
  }
}

export function writeVncStreamSettings(settings: VncStreamSettings): void {
  window.localStorage.setItem(VNC_STREAM_SETTINGS_KEY, JSON.stringify(normalizeVncStreamSettings(settings)));
}

export function normalizeVncStreamSettings(settings: Partial<VncStreamSettings>): VncStreamSettings {
  const profile = isVncStreamProfile(settings.profile) ? settings.profile : DEFAULT_VNC_STREAM_SETTINGS.profile;
  const fallback = PROFILE_BY_ID.get(profile)?.settings || DEFAULT_VNC_STREAM_SETTINGS;
  return {
    profile,
    quality: clampVncLevel(settings.quality, fallback.quality),
    compression: clampVncLevel(settings.compression, fallback.compression),
    dynamicQualityMin: clampVncLevel(settings.dynamicQualityMin, fallback.dynamicQualityMin),
    dynamicQualityMax: clampVncLevel(settings.dynamicQualityMax, fallback.dynamicQualityMax),
    treatLossless: clampVncLevel(settings.treatLossless, fallback.treatLossless),
    jpegVideoQuality: clampVncLevel(settings.jpegVideoQuality, fallback.jpegVideoQuality),
    webpVideoQuality: clampVncLevel(settings.webpVideoQuality, fallback.webpVideoQuality),
    videoQuality: clampInteger(settings.videoQuality, fallback.videoQuality, 0, 10),
    videoArea: clampInteger(settings.videoArea, fallback.videoArea, 0, 100),
    videoTime: clampInteger(settings.videoTime, fallback.videoTime, 0, 100),
    videoOutTime: clampInteger(settings.videoOutTime, fallback.videoOutTime, 1, 100),
    videoScaling: clampInteger(settings.videoScaling, fallback.videoScaling, 0, 2),
    maxVideoResolutionX: clampInteger(settings.maxVideoResolutionX, fallback.maxVideoResolutionX, 100, 7680),
    maxVideoResolutionY: clampInteger(settings.maxVideoResolutionY, fallback.maxVideoResolutionY, 100, 4320),
    frameRate: clampInteger(settings.frameRate, fallback.frameRate, 1, 120),
    enableWebP: typeof settings.enableWebP === 'boolean' ? settings.enableWebP : fallback.enableWebP,
    audio: profile === 'speed' ? false : typeof settings.audio === 'boolean' ? settings.audio : fallback.audio,
  };
}

function isVncStreamProfile(value: unknown): value is VncStreamProfile {
  return value === 'speed' || value === 'balanced' || value === 'quality';
}

function clampVncLevel(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(9, Math.round(value)));
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}
