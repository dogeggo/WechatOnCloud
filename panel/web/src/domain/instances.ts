import type { AppType, InstanceWithStatus, RuntimeState, WechatPhase } from '../api';

export const BUSY_WECHAT_PHASES: WechatPhase[] = ['downloading', 'extracting', 'installing'];
export const APP_TYPES: AppType[] = ['wechat', 'chromium'];

export type LifecycleAction = 'stop' | 'restart' | 'upgrade';
export type WechatInstallAction = 'install' | 'update';

export interface AppProfile {
  label: string;
  createLabel: string;
  icon: string;
  needsInstall: boolean;
  enterHint: string;
  installedText: string;
  notInstalledText: string;
  installTitle: string;
  installButtonTitle: string;
  updateLabel: string;
}

export const APP_PROFILES: Record<AppType, AppProfile> = {
  wechat: {
    label: '微信',
    createLabel: '微信',
    icon: '微',
    needsInstall: true,
    enterHint: '首次进入请扫码登录微信',
    installedText: '微信已安装',
    notInstalledText: '微信尚未安装',
    installTitle: '微信尚未安装',
    installButtonTitle: '需先下载安装微信',
    updateLabel: '更新微信',
  },
  chromium: {
    label: 'Chromium',
    createLabel: 'Chromium 浏览器',
    icon: 'C',
    needsInstall: false,
    enterHint: '浏览器已就绪，直接使用即可',
    installedText: 'Chromium 已就绪',
    notInstalledText: 'Chromium 随镜像就绪',
    installTitle: 'Chromium 尚未就绪',
    installButtonTitle: '浏览器尚未就绪',
    updateLabel: '',
  },
};

export function appProfile(type?: AppType): AppProfile {
  return APP_PROFILES[type ?? 'wechat'] ?? APP_PROFILES.wechat;
}

export interface StatusLabel {
  cls: string;
  text: string;
}

export interface InstanceCardState {
  badge: StatusLabel;
  sub: string;
  busy: boolean;
  installed: boolean;
  offline: boolean;
  working: boolean;
}

export function isWechatBusy(phase: WechatPhase): boolean {
  return BUSY_WECHAT_PHASES.includes(phase);
}

export function isRuntimeOffline(runtime: RuntimeState): boolean {
  return runtime !== 'running';
}

export function isWechatInstalled(inst: InstanceWithStatus): boolean {
  return inst.wechat.installed && inst.wechat.phase !== 'downloading';
}

export function sidebarStatus(inst: InstanceWithStatus): StatusLabel {
  if (isRuntimeOffline(inst.runtime)) return { cls: 'st-off', text: inst.runtime === 'missing' ? '未创建' : '已停止' };
  if (isWechatBusy(inst.wechat.phase)) return { cls: 'st-busy', text: '处理中' };
  if (isWechatInstalled(inst)) return { cls: 'st-on', text: '在线' };
  return { cls: 'st-warn', text: '待安装' };
}

export function adminCardState(inst: InstanceWithStatus, acting?: string): InstanceCardState {
  const profile = appProfile(inst.appType);
  const busy = isWechatBusy(inst.wechat.phase);
  const offline = isRuntimeOffline(inst.runtime);
  const installed = isWechatInstalled(inst);
  const working = !!acting || busy;
  const wx = inst.wechat;

  let badge: StatusLabel;
  if (acting) badge = { text: '处理中', cls: 'tag-busy' };
  else if (offline) badge = { text: inst.runtime === 'missing' ? '未创建' : '已停止', cls: 'tag-off' };
  else if (busy) badge = { text: '处理中', cls: 'tag-busy' };
  else if (installed) badge = { text: '在线', cls: 'tag-on' };
  else badge = { text: '待安装', cls: 'tag-warn' };

  let sub: string;
  if (acting) sub = acting;
  else if (busy) sub = wx.percent >= 0 ? `${wx.message || '处理中'} ${wx.percent}%` : wx.message || '请稍候...';
  else if (wx.phase === 'error') sub = wx.message || '操作失败，可重试';
  else if (offline) sub = inst.runtime === 'missing' ? '容器尚未创建' : '容器已停止';
  else if (installed) sub = wx.version ? `${profile.label} ${wx.version}` : profile.installedText;
  else sub = profile.notInstalledText;

  return { badge, sub, busy, installed, offline, working };
}

export function lifecycleBusyLabel(action: LifecycleAction): string {
  if (action === 'stop') return '停止中...';
  if (action === 'upgrade') return '升级中...';
  return '重启中...';
}

export function lifecycleDoneMessage(action: LifecycleAction): string {
  if (action === 'stop') return '已停止';
  if (action === 'upgrade') return '已升级到最新镜像并重启';
  return '已重启';
}

export function wechatActionDoneMessage(action: WechatInstallAction): string {
  return action === 'install' ? '已开始下载微信' : '已开始更新';
}

export function desktopUrl(id: string): string {
  const params = new URLSearchParams({
    autoconnect: '1',
    path: `desktop/${id}/websockify`,
    resize: 'remote',
    reconnect: 'true',
    reconnect_delay: '2000',
    clipboard_up: 'true',
    clipboard_down: 'true',
    clipboard_seamless: 'true',
  });
  return `/desktop/${id}/vnc/index.html?${params.toString()}`;
}

export function routeInstanceId(pathname: string): string | null {
  const match = pathname.match(/^\/i\/([0-9a-f]{10})$/);
  return match ? match[1] : null;
}
