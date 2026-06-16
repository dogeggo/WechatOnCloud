import type { VncServerProfile } from '../api';

export interface VncServerProfileOption {
  profile: VncServerProfile;
  label: string;
  description: string;
  detail: string;
}

export const VNC_SERVER_PROFILE_OPTIONS: VncServerProfileOption[] = [
  {
    profile: 'speed',
    label: '省流',
    description: '降低帧率和图像质量，优先抗高峰期卡顿',
    detail: '15 fps · 低质量 · 更早进入视频编码',
  },
  {
    profile: 'balanced',
    label: '均衡',
    description: '兼顾清晰度和带宽占用，推荐日常使用',
    detail: '24 fps · 中等质量 · 默认档位',
  },
  {
    profile: 'quality',
    label: '清晰',
    description: '提升远端画面细节，适合网络较稳定时使用',
    detail: '30 fps · 高质量 · 带宽占用更高',
  },
];

export function vncServerProfileLabel(profile: VncServerProfile): string {
  return VNC_SERVER_PROFILE_OPTIONS.find((item) => item.profile === profile)?.label ?? '均衡';
}
