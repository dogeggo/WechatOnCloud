import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { PanelUser } from './api';
import { useAuth } from './auth';
import { useUI } from './ui';
import InstanceView from './pages/Desktop';
import Admin from './pages/Admin';
import { InstanceIcon } from './AppIcon';
import { Icons } from './components/icons';
import { appProfile, routeInstanceId, sidebarStatus } from './domain/instances';
import { InstancesCtx, useInstances } from './features/instances/instances-context';
import { useInstancesLoader } from './features/instances/useInstancesLoader';
import { useBrowserNotifications, type BrowserNotificationStatus } from './features/notifications/useBrowserNotifications';
import {
  idFromVncKeepAliveKey,
  isVncKeepAliveEnabled,
  isVncKeepAliveKey,
  VNC_KEEP_ALIVE_EVENT,
  type VncKeepAliveChange,
} from './vncKeepAlive';

// ---- 实例数据：侧栏 / 主页 / 实例视图共享，安装中轮询 ----
export default function AppShell() {
  const state = useInstancesLoader();
  const browserNotifications = useBrowserNotifications();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('woc_sb_collapsed') === '1');
  const [drawer, setDrawer] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  const [keepAliveIds, setKeepAliveIds] = useState<string[]>([]);
  const [, setKeepAliveRev] = useState(0);
  const loc = useLocation();
  const activeInstanceId = routeInstanceId(loc.pathname);
  const activeKeepAlive = !!activeInstanceId && isVncKeepAliveEnabled(activeInstanceId);
  const cachedIds = activeKeepAlive && activeInstanceId && !keepAliveIds.includes(activeInstanceId)
    ? [...keepAliveIds, activeInstanceId]
    : keepAliveIds;
  const showingCachedInstance = !!activeInstanceId && cachedIds.includes(activeInstanceId);

  useEffect(() => {
    const m = window.matchMedia('(min-width: 768px)');
    const h = () => setIsDesktop(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);

  useEffect(() => setDrawer(false), [loc.pathname]); // 路由变化关抽屉

  // 路由切换时刷新共享实例列表：主页和实例页依赖这里的上下文；管理页自己在加载时会单独刷新一遍。
  // 不清空旧数据，拉取期间沿用旧列表，无闪烁。
  useEffect(() => {
    if (loc.pathname !== '/admin') void state.reload();
  }, [loc.pathname, state.reload]);

  useEffect(() => {
    if (!activeInstanceId || !activeKeepAlive) return;
    setKeepAliveIds((ids) => (ids.includes(activeInstanceId) ? ids : [...ids, activeInstanceId]));
  }, [activeInstanceId, activeKeepAlive]);

  useEffect(() => {
    const onChanged = (e: Event) => {
      const { id, enabled } = (e as CustomEvent<VncKeepAliveChange>).detail;
      setKeepAliveRev((n) => n + 1);
      if (!enabled) setKeepAliveIds((ids) => ids.filter((x) => x !== id));
    };
    const onStorage = (e: StorageEvent) => {
      if (!isVncKeepAliveKey(e.key)) return;
      const id = idFromVncKeepAliveKey(e.key!);
      setKeepAliveRev((n) => n + 1);
      if (e.newValue !== '1') setKeepAliveIds((ids) => ids.filter((x) => x !== id));
    };
    window.addEventListener(VNC_KEEP_ALIVE_EVENT, onChanged as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(VNC_KEEP_ALIVE_EVENT, onChanged as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    if (!state.loaded) return;
    const live = new Set(state.instances.map((i) => i.id));
    setKeepAliveIds((ids) => ids.filter((id) => live.has(id) && isVncKeepAliveEnabled(id)));
  }, [state.loaded, state.instances]);

  // 移动端不收成窄栏（改用抽屉）；折叠仅桌面生效
  const railed = collapsed && isDesktop;

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem('woc_sb_collapsed', c ? '0' : '1');
      return !c;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openMenu = () => setDrawer(true);

  return (
    <InstancesCtx.Provider value={state}>
      <div className={'shell' + (railed ? ' collapsed' : '') + (drawer ? ' drawer-open' : '')}>
        <Sidebar
          collapsed={railed}
          notificationStatus={browserNotifications.notificationStatus}
          onToggleCollapsed={toggleCollapsed}
          onToggleNotifications={browserNotifications.toggleBrowserNotifications}
        />
        <div className="shell-backdrop" onClick={() => setDrawer(false)} />
        <main className="workspace">
          <div className={'workspace-route' + (showingCachedInstance ? ' hidden' : '')}>
            <Routes>
              <Route path="/" element={<HomeView onOpenMenu={openMenu} />} />
              <Route path="/admin" element={<Admin onOpenMenu={openMenu} />} />
              <Route path="/i/:id" element={showingCachedInstance ? null : <InstanceView onOpenMenu={openMenu} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
          {cachedIds.map((id) => (
            <div key={id} className={'workspace-keepalive' + (activeInstanceId === id ? ' active' : '')}>
              <InstanceView instanceId={id} active={activeInstanceId === id} onOpenMenu={openMenu} />
            </div>
          ))}
        </main>
      </div>
    </InstancesCtx.Provider>
  );
}

function Sidebar({
  collapsed,
  notificationStatus,
  onToggleCollapsed,
  onToggleNotifications,
}: {
  collapsed: boolean;
  notificationStatus: BrowserNotificationStatus;
  onToggleCollapsed: () => void;
  onToggleNotifications: () => void;
}) {
  const { user, logout } = useAuth();
  const { confirm } = useUI();
  const { instances } = useInstances();
  const nav = useNavigate();
  const loc = useLocation();
  const go = (p: string) => nav(p);

  return (
    <aside className="sidebar">
      <div className="sb-top">
        <div className="sb-brand">
          <img src="/favicon.svg" className="sb-logo" alt="" />
          {!collapsed && <span className="sb-name">云应用</span>}
        </div>
        <button className="sb-collapse" title="折叠侧栏 (⌘B)" onClick={onToggleCollapsed}>
          {Icons.collapse}
        </button>
      </div>

      <nav className="sb-nav">
        <button className={'sb-item' + (loc.pathname === '/' ? ' on' : '')} onClick={() => go('/')} title="主页">
          <span className="sb-ic">{Icons.home}</span>
          {!collapsed && <span className="sb-label">主页</span>}
        </button>
      </nav>

      {!collapsed && <div className="sb-section">应用实例</div>}
      <div className="sb-list">
        {instances.length === 0 && !collapsed && <div className="sb-empty">暂无可用实例</div>}
        {instances.map((inst) => {
          const on = loc.pathname === `/i/${inst.id}`;
          const st = sidebarStatus(inst);
          return (
            <button key={inst.id} className={'sb-item sb-inst' + (on ? ' on' : '')} onClick={() => go(`/i/${inst.id}`)} title={inst.name}>
              <span className="sb-avatar">
                <InstanceIcon icon={inst.icon} appType={inst.appType} size={32} radius={9} />
                <span className={'sb-dot ' + st.cls} />
              </span>
              {!collapsed && <span className="sb-label">{inst.name}</span>}
              {!collapsed && <span className="sb-stxt">{st.text}</span>}
            </button>
          );
        })}
      </div>

      <div className="sb-footer">
        <button
          className={'sb-item' + (notificationStatus === 'on' ? ' on' : '')}
          onClick={onToggleNotifications}
          title={notificationTitle(notificationStatus)}
        >
          <span className="sb-ic">{notificationStatus === 'on' ? Icons.bell : Icons.bellOff}</span>
          {!collapsed && <span className="sb-label">通知</span>}
          {!collapsed && <span className="sb-stxt">{notificationText(notificationStatus)}</span>}
        </button>
        <button className={'sb-item' + (loc.pathname === '/admin' ? ' on' : '')} onClick={() => go('/admin')} title="管理">
          <span className="sb-ic">{Icons.gear}</span>
          {!collapsed && <span className="sb-label">管理</span>}
        </button>
        <button
          className="sb-item"
          title="退出"
          onClick={async () => {
            if (await confirm({ title: '退出登录？', confirmText: '退出' })) logout();
          }}
        >
          <span className="sb-ic">{Icons.logout}</span>
          {!collapsed && <span className="sb-label">退出</span>}
        </button>
        {!collapsed && (
          <div className="sb-user" title={user?.email}>
            {user && <AccountAvatar user={user} variant="sidebar" />}
            <span className="sb-user-name">{user?.username || user?.email}</span>
          </div>
        )}
      </div>
    </aside>
  );
}

function AccountAvatar({ user, variant }: { user: PanelUser; variant: 'sidebar' | 'home' }) {
  const displayName = user.username || user.email;
  const initial = displayName.trim().charAt(0).toUpperCase();

  return (
    <span className={`account-avatar account-avatar-${variant}`}>
      {user.picture ? (
        <img src={user.picture} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span>{initial}</span>
      )}
    </span>
  );
}

function notificationTitle(status: BrowserNotificationStatus): string {
  if (status === 'on') return '关闭浏览器通知';
  if (status === 'blocked') return '浏览器已拒绝通知';
  if (status === 'unsupported') return '当前浏览器不支持通知';
  return '开启浏览器通知';
}

function notificationText(status: BrowserNotificationStatus): string {
  if (status === 'on') return '开';
  if (status === 'blocked') return '拒绝';
  if (status === 'unsupported') return '不可用';
  return '关';
}

function HomeView({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { user } = useAuth();
  const { instances, loaded } = useInstances();
  const nav = useNavigate();

  return (
    <div className="ws-page">
      <header className="ws-head">
        <button className="ws-menu" onClick={onOpenMenu} aria-label="菜单">
          {Icons.menu}
        </button>
        <span className="ws-title">主页</span>
      </header>

      <div className="content">
        <div className="hello">
          {user && <AccountAvatar user={user} variant="home" />}
          <span className="hello-text">
            你好，<b>{user?.username || user?.email}</b>
          </span>
        </div>

        <div className="section-row">
          <span className="section-title">应用实例</span>
          <button className="btn-text" onClick={() => nav('/admin')}>
            管理 ›
          </button>
        </div>

        {loaded && instances.length === 0 ? (
          <div className="empty-state">
            <div className="empty-blob">
              <img src="/favicon.svg" alt="" />
            </div>
            <div className="empty-title">还没有应用实例</div>
            <div className="empty-sub">去「管理」新建微信、QQ 或 Chromium 实例</div>
          </div>
        ) : (
          <div className="inst-grid">
            {instances.map((inst) => {
              const st = sidebarStatus(inst);
              const profile = appProfile(inst.appType);
              const meta = inst.app.installed
                ? `${profile.label} ${inst.app.version || ''}`.trim()
                : inst.runtime === 'running'
                  ? profile.needsInstall ? `待下载安装${profile.label}` : `${profile.label} 尚未就绪`
                  : '';
              return (
                <button key={inst.id} className="home-card" onClick={() => nav(`/i/${inst.id}`)}>
                  <span className="home-card-av">
                    <InstanceIcon icon={inst.icon} appType={inst.appType} size={42} radius={12} />
                  </span>
                  <span className="home-card-main">
                    <span className="home-card-name">{inst.name}</span>
                    <span className="home-card-meta">
                      <span className={'home-card-st ' + st.cls}>● {st.text}</span>
                      {meta && <span className="home-card-ver">{meta}</span>}
                    </span>
                  </span>
                  <span className="enter-arrow">›</span>
                </button>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
}
