export type VncStreamProfile = 'speed' | 'balanced' | 'quality';

export interface VncStreamSettings {
  profile: VncStreamProfile;
  quality: number;
  compression: number;
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
    settings: { profile: 'speed', quality: 4, compression: 8, audio: false },
  },
  {
    profile: 'balanced',
    label: '均衡',
    title: '日常使用，兼顾清晰度和流量',
    settings: { profile: 'balanced', quality: 5, compression: 7, audio: true },
  },
  {
    profile: 'quality',
    label: '清晰',
    title: '提高画质，适合网络较稳定时使用',
    settings: { profile: 'quality', quality: 8, compression: 4, audio: true },
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
    audio: profile === 'speed' ? false : typeof settings.audio === 'boolean' ? settings.audio : fallback.audio,
  };
}

function isVncStreamProfile(value: unknown): value is VncStreamProfile {
  return value === 'speed' || value === 'balanced' || value === 'quality';
}

function clampVncLevel(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(9, Math.round(value)));
}
