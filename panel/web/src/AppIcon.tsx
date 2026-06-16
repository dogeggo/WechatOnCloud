import type { ReactNode } from 'react';
import type { AppType } from './api';

type Glyph = {
  bg: string;
  el: ReactNode;
};

const glyph = (bg: string, el: ReactNode): Glyph => ({ bg, el });

const chat = (
  <path
    fill="#fff"
    d="M19 12c-6.6 0-12 4.2-12 9.5 0 3 1.8 5.7 4.6 7.4l-1.1 3.9 4.4-2.3c1.3.3 2.7.5 4.1.5 6.6 0 12-4.2 12-9.5S25.6 12 19 12zm-4 8.2a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2zm8 0a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2z"
  />
);

const globe = (
  <g fill="none" stroke="#fff" strokeWidth="2.4">
    <circle cx="24" cy="24" r="13" />
    <ellipse cx="24" cy="24" rx="5.5" ry="13" />
    <path d="M11.5 20h25M11.5 28h25" />
  </g>
);

const plane = <path fill="#fff" d="M35 14L13 23.2l6.1 2.2 2.3 7.2 3.3-3.9 5.6 4.1L35 14zm-12.4 12.6l9-7.2-6.7 8.1-.1 3.6-2.2-4.5z" />;

const dots = (
  <g fill="#fff">
    <circle cx="16" cy="24" r="2.6" />
    <circle cx="24" cy="24" r="2.6" />
    <circle cx="32" cy="24" r="2.6" />
  </g>
);

const txt = (s: string, fs = 22) => (
  <text
    x="24"
    y="25"
    fill="#fff"
    fontSize={fs}
    fontWeight="700"
    textAnchor="middle"
    dominantBaseline="central"
    fontFamily="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
  >
    {s}
  </text>
);

const play = <path fill="#fff" d="M20 17l12 7-12 7z" />;

export const BUILTIN_ICONS: Record<string, Glyph> = {
  wechat: glyph('#07c160', chat),
  chromium: glyph('#4285f4', globe),
  qq: glyph('#12b7f5', txt('Q', 26)),
  telegram: glyph('#2aabee', plane),
  xiaohongshu: glyph('#ff2442', txt('书')),
  douyin: glyph('#111111', txt('抖')),
  bilibili: glyph('#fb7299', txt('B', 26)),
  weibo: glyph('#e6162d', txt('微')),
  zhihu: glyph('#0084ff', txt('知')),
  youtube: glyph('#ff0000', play),
  globe: glyph('#5b8def', globe),
  app: glyph('#8a9099', dots),
};

export const ICON_CHOICES: { key: string; label: string }[] = [
  { key: 'wechat', label: '微信' },
  { key: 'chromium', label: 'Chromium' },
  { key: 'qq', label: 'QQ' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'douyin', label: '抖音' },
  { key: 'bilibili', label: 'B站' },
  { key: 'weibo', label: '微博' },
  { key: 'zhihu', label: '知乎' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'globe', label: '通用' },
];

const DEFAULT_BY_APP: Record<AppType, string> = {
  wechat: 'wechat',
  chromium: 'chromium',
  qq: 'qq',
  telegram: 'telegram',
};

export function InstanceIcon({
  icon,
  appType,
  size = 36,
  radius = 12,
}: {
  icon?: string;
  appType?: AppType;
  size?: number;
  radius?: number;
}) {
  const value = icon?.trim();

  if (value?.startsWith('data:image/')) {
    return (
      <img
        src={value}
        width={size}
        height={size}
        alt=""
        style={{ borderRadius: radius, objectFit: 'cover', display: 'block' }}
      />
    );
  }

  const key = value?.startsWith('builtin:') ? value.slice(8) : DEFAULT_BY_APP[appType ?? 'wechat'] ?? 'app';
  const item = BUILTIN_ICONS[key] ?? BUILTIN_ICONS.app;

  return (
    <svg width={size} height={size} viewBox="0 0 48 48" style={{ display: 'block' }} aria-hidden="true">
      <rect width="48" height="48" rx={(radius / size) * 48} fill={item.bg} />
      {item.el}
    </svg>
  );
}
