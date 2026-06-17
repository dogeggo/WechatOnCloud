import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { InstanceWithStatus } from '../api';
import { EmptyState } from '../components/EmptyState';
import { Icons } from '../components/icons';
import { deviceName } from '../domain/devices';
import { appProfile } from '../domain/instances';
import { CreateInstance } from '../features/admin/components/CreateInstance';
import { DeleteInstance } from '../features/admin/components/DeleteInstance';
import { InstanceAdminCard } from '../features/admin/components/InstanceAdminCard';
import { InstanceIconEditor } from '../features/admin/components/InstanceIconEditor';
import { InstanceLogs } from '../features/admin/components/InstanceLogs';
import { InstanceSecurity } from '../features/admin/components/InstanceSecurity';
import { InstanceVncServerProfile } from '../features/admin/components/InstanceVncServerProfile';
import { RenameInstance } from '../features/admin/components/RenameInstance';
import { VolumeManager } from '../features/admin/components/VolumeManager';
import { useAdminPanel } from '../features/admin/useAdminPanel';
import { useUI } from '../ui';
import { formatIsoDate, formatMiB } from '../utils/format';

export default function Admin({ onOpenMenu }: { onOpenMenu: () => void }) {
  const nav = useNavigate();
  const { toast } = useUI();
  const {
    isAdmin,
    instances,
    forgetInstance,
    patchInstance,
    devices,
    orphanVolumes,
    orphanContainers,
    acting,
    err,
    load,
    removeDevice,
    removeOrphanContainer,
    removeOrphanVolume,
    triggerAppInstall,
    startInstance,
    runLifecycle,
  } = useAdminPanel();
  const [creatingInst, setCreatingInst] = useState(false);
  const [createReuseVolume, setCreateReuseVolume] = useState('');
  const [deleteInst, setDeleteInst] = useState<InstanceWithStatus | null>(null);
  const [renameInst, setRenameInst] = useState<InstanceWithStatus | null>(null);
  const [securityInst, setSecurityInst] = useState<InstanceWithStatus | null>(null);
  const [vncServerInst, setVncServerInst] = useState<InstanceWithStatus | null>(null);
  const [volumeInst, setVolumeInst] = useState<InstanceWithStatus | null>(null);
  const [iconInst, setIconInst] = useState<InstanceWithStatus | null>(null);
  const [logsInst, setLogsInst] = useState<InstanceWithStatus | null>(null);
  const deletingInstId = deleteInst?.id;
  const openCreateInstance = (reuseVolume = '') => {
    setCreateReuseVolume(reuseVolume);
    setCreatingInst(true);
  };

  return (
    <div className="ws-page">
      <header className="ws-head">
        <button className="ws-menu" onClick={onOpenMenu} aria-label="菜单">
          {Icons.menu}
        </button>
        <span className="ws-title">管理</span>
      </header>

      <main className="content">
        {err && <div className="error">{err}</div>}

        <div className="section-row">
          <span className="section-title">{isAdmin ? '全部应用实例' : '应用实例'}</span>
          <button className="btn-text" onClick={() => openCreateInstance()}>
            + 新建实例
          </button>
        </div>
        {instances.length === 0 ? (
          <EmptyState
            icon="🖥️"
            title="还没有应用实例"
            sub="新建微信、QQ 或 Chromium 实例，进入后即可在浏览器里使用"
            action={
              <button className="btn btn-primary" onClick={() => openCreateInstance()}>
                ＋ 新建实例
              </button>
            }
          />
        ) : (
          <div className="inst-grid">
            {instances.map((inst) => (
              <InstanceAdminCard
                key={inst.id}
                inst={inst}
                acting={acting[inst.id]}
                onEnter={() => nav(`/i/${inst.id}`)}
                onTrigger={triggerAppInstall}
                onStart={() => startInstance(inst)}
                onStop={() => runLifecycle(inst, 'stop')}
                onRestart={() => runLifecycle(inst, 'restart')}
                onUpgrade={() => runLifecycle(inst, 'upgrade')}
                onRename={() => setRenameInst(inst)}
                onIcon={() => setIconInst(inst)}
                onLogs={() => setLogsInst(inst)}
                onDelete={() => setDeleteInst(inst)}
                onSecurity={() => setSecurityInst(inst)}
                onVncServerProfile={() => setVncServerInst(inst)}
                onVolume={() => setVolumeInst(inst)}
                showOwner={isAdmin}
              />
            ))}
          </div>
        )}

        <div className="section-row" style={{ marginTop: 22 }}>
          <span className="section-title">{isAdmin ? '全部已登录设备' : '已登录设备'}</span>
          <span className="muted small">{isAdmin ? '可移除任意账号的面板登录态' : '可移除不再使用的面板登录态'}</span>
        </div>
        <div className="inst-grid">
          {devices.length === 0 ? (
            <div className="inst-card">
              <div className="muted small">暂无设备记录</div>
            </div>
          ) : (
            devices.map((d) => (
              <div key={d.id} className="inst-card device-card">
                <div className="inst-head">
                  <span className="inst-name">{deviceName(d.userAgent)}</span>
                  <span className={'tag ' + (d.current ? 'tag-on' : '')}>{d.current ? '当前设备' : '已登录'}</span>
                </div>
                <div className="device-meta">
                  {isAdmin && <div>账号：{d.user.email}{d.user.isAdmin ? '（管理员）' : ''}</div>}
                  <div>IP：{d.ip || 'unknown'}</div>
                  <div>最近活动：{formatIsoDate(d.lastSeenAt)}</div>
                  <div>登录时间：{formatIsoDate(d.createdAt)}</div>
                  <div>过期时间：{formatIsoDate(d.expiresAt)}</div>
                  <div className="device-ua" title={d.userAgent}>{d.userAgent}</div>
                </div>
                <div className="inst-admin-links">
                  <button className="btn-text danger" onClick={() => removeDevice(d)}>
                    {d.current ? '移除当前设备' : '移除设备'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {isAdmin && orphanContainers.length > 0 && (
          <>
            <div className="section-row" style={{ marginTop: 22 }}>
              <span className="section-title">残留容器</span>
              <span className="muted small">不属于任何登记实例（多为创建失败遗留）；它们占着数据卷名，需先清理它们才能删除同名数据卷。</span>
            </div>
            <div className="inst-grid">
              {orphanContainers.map((c) => (
                <div key={c.id} className="inst-card">
                  <div className="inst-head">
                    <span className="inst-name" style={{ fontFamily: 'monospace', fontSize: 13 }}>{c.name}</span>
                    <span className="tag tag-off">{c.status || 'unknown'}</span>
                  </div>
                  {c.volumeName && (
                    <div className="inst-sub" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      占用卷：{c.volumeName}
                    </div>
                  )}
                  <div className="inst-admin-links">
                    <button className="btn-text danger" onClick={() => removeOrphanContainer(c)}>
                      删除容器
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {isAdmin && orphanVolumes.length > 0 && (
          <>
            <div className="section-row" style={{ marginTop: 22 }}>
              <span className="section-title">未使用的数据卷</span>
              <span className="muted small">带归属标记的卷可复用以继承应用数据；未标记卷只能彻底删除。</span>
            </div>
            <div className="inst-grid">
              {orphanVolumes.map((v) => (
                <div key={v.name} className="inst-card">
                  <div className="inst-head">
                    <span className="inst-name" style={{ fontFamily: 'monospace', fontSize: 13 }}>{v.name}</span>
                    <span className={'tag ' + (v.appType ? 'tag-on' : 'tag-off')}>
                      {v.appType ? appProfile(v.appType).label : '未标记'}
                    </span>
                  </div>
                  <div className="inst-sub">
                    归属：{v.appType ? appProfile(v.appType).label : '未标记，不能复用'}
                    {'　·　'}
                    {v.createdAt ? `创建于 ${v.createdAt.slice(0, 10)}` : '创建时间未知'}
                    {typeof v.sizeBytes === 'number' ? `　·　${formatMiB(v.sizeBytes)}` : ''}
                  </div>
                  <div className="inst-admin-links">
                    {v.appType && (
                      <button className="btn-text" onClick={() => openCreateInstance(v.name)} title="打开「新建实例」并复用此数据卷">
                        复用为新实例
                      </button>
                    )}
                    <button className="btn-text danger" onClick={() => removeOrphanVolume(v.name)}>
                      彻底删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      {creatingInst && (
        <CreateInstance
          initialReuseVolume={createReuseVolume}
          onClose={() => {
            setCreatingInst(false);
            setCreateReuseVolume('');
          }}
          onDone={() => {
            setCreatingInst(false);
            setCreateReuseVolume('');
            load();
          }}
        />
      )}
      {deleteInst && (
        <DeleteInstance
          inst={deleteInst}
          onClose={() => setDeleteInst(null)}
          onDone={() => {
            if (deletingInstId) forgetInstance(deletingInstId);
            setDeleteInst(null);
            toast('实例已删除', 'ok');
            load();
          }}
        />
      )}
      {renameInst && (
        <RenameInstance
          inst={renameInst}
          onClose={() => setRenameInst(null)}
          onDone={(instance) => {
            patchInstance(instance);
            setRenameInst(null);
            toast('已重命名', 'ok');
          }}
        />
      )}
      {securityInst && (
        <InstanceSecurity
          inst={securityInst}
          onClose={() => setSecurityInst(null)}
          onDone={(instance) => {
            if (!instance) {
              load();
              return;
            }
            patchInstance(instance);
            toast('已保存安全阈值', 'ok');
          }}
        />
      )}
      {vncServerInst && (
        <InstanceVncServerProfile
          inst={vncServerInst}
          onClose={() => setVncServerInst(null)}
          onDone={(instance) => {
            patchInstance(instance);
            load();
          }}
        />
      )}
      {volumeInst && (
        <VolumeManager inst={volumeInst} onClose={() => setVolumeInst(null)} onChanged={load} />
      )}
      {iconInst && (
        <InstanceIconEditor
          inst={iconInst}
          onClose={() => setIconInst(null)}
          onDone={(instance) => patchInstance(instance)}
        />
      )}
      {logsInst && (
        <InstanceLogs inst={logsInst} onClose={() => setLogsInst(null)} />
      )}
    </div>
  );
}
