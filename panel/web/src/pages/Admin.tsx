import { useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import Cropper from 'react-easy-crop';
import { api, type InstanceWithStatus, type VolEntry } from '../api';
import { ICON_CHOICES, InstanceIcon } from '../AppIcon';
import { EmptyState } from '../components/EmptyState';
import { Icons } from '../components/icons';
import { APP_TYPES, adminCardState, appProfile, type WechatInstallAction } from '../domain/instances';
import { deviceName } from '../domain/devices';
import { joinVolumePath } from '../domain/volumePaths';
import { useCreateInstance } from '../features/admin/useCreateInstance';
import { useAdminPanel } from '../features/admin/useAdminPanel';
import { useDeleteInstance } from '../features/admin/useDeleteInstance';
import { useInstanceRename } from '../features/admin/useInstanceRename';
import { useInstanceSecurity } from '../features/admin/useInstanceSecurity';
import { useVolumeManager } from '../features/admin/useVolumeManager';
import { useUI } from '../ui';
import { errorMessage } from '../utils/errors';
import { formatBytes, formatDate, formatIsoDate, formatMiB } from '../utils/format';

export default function Admin({ onOpenMenu }: { onOpenMenu: () => void }) {
  const nav = useNavigate();
  const { toast } = useUI();
  const {
    instances,
    devices,
    orphanVolumes,
    orphanContainers,
    vncKeepAlive,
    acting,
    err,
    load,
    removeDevice,
    removeOrphanContainer,
    removeOrphanVolume,
    triggerWechat,
    startInstance,
    runLifecycle,
    toggleVncKeepAlive,
  } = useAdminPanel();
  const [creatingInst, setCreatingInst] = useState(false);
  const [deleteInst, setDeleteInst] = useState<InstanceWithStatus | null>(null); // 删除实例弹窗
  const [renameInst, setRenameInst] = useState<InstanceWithStatus | null>(null); // 重命名实例弹窗
  const [securityInst, setSecurityInst] = useState<InstanceWithStatus | null>(null); // 安全（内存阈值）弹窗
  const [volumeInst, setVolumeInst] = useState<InstanceWithStatus | null>(null); // 数据卷管理弹窗
  const [iconInst, setIconInst] = useState<InstanceWithStatus | null>(null); // 图标编辑弹窗

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
          <span className="section-title">应用实例</span>
          <button className="btn-text" onClick={() => setCreatingInst(true)}>
            + 新建实例
          </button>
        </div>
        {instances.length === 0 ? (
          <EmptyState
            icon="🖥️"
            title="还没有应用实例"
            sub="新建微信或 Chromium 实例，进入后即可在浏览器里使用"
            action={
              <button className="btn btn-primary" onClick={() => setCreatingInst(true)}>
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
                onTrigger={triggerWechat}
                onStart={() => startInstance(inst)}
                onStop={() => runLifecycle(inst, 'stop')}
                onRestart={() => runLifecycle(inst, 'restart')}
                onUpgrade={() => runLifecycle(inst, 'upgrade')}
                onRename={() => setRenameInst(inst)}
                onIcon={() => setIconInst(inst)}
                onDelete={() => setDeleteInst(inst)}
                onSecurity={() => setSecurityInst(inst)}
                onVolume={() => setVolumeInst(inst)}
                vncKeepAlive={!!vncKeepAlive[inst.id]}
                onToggleVncKeepAlive={(enabled) => toggleVncKeepAlive(inst, enabled)}
              />
            ))}
          </div>
        )}

        <div className="section-row" style={{ marginTop: 22 }}>
          <span className="section-title">已登录设备</span>
          <span className="muted small">可移除不再使用的面板登录态</span>
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

        {orphanContainers.length > 0 && (
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
        {orphanVolumes.length > 0 && (
          <>
            <div className="section-row" style={{ marginTop: 22 }}>
              <span className="section-title">未使用的数据卷</span>
              <span className="muted small">删除实例时未勾选「彻底清除」会保留下来；可在新建实例时复用以继承聊天记录。</span>
            </div>
            <div className="inst-grid">
              {orphanVolumes.map((v) => (
                <div key={v.name} className="inst-card">
                  <div className="inst-head">
                    <span className="inst-name" style={{ fontFamily: 'monospace', fontSize: 13 }}>{v.name}</span>
                  </div>
                  <div className="inst-sub">
                    {v.createdAt ? `创建于 ${v.createdAt.slice(0, 10)}` : '创建时间未知'}
                    {typeof v.sizeBytes === 'number' ? `　·　${formatMiB(v.sizeBytes)}` : ''}
                  </div>
                  <div className="inst-admin-links">
                    <button className="btn-text" onClick={() => setCreatingInst(true)} title="去「新建实例」对话框，在「数据卷」下拉里选择复用此卷">
                      复用为新实例
                    </button>
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
          onClose={() => setCreatingInst(false)}
          onDone={() => {
            setCreatingInst(false);
            load();
          }}
        />
      )}
      {deleteInst && (
        <DeleteInstance
          inst={deleteInst}
          onClose={() => setDeleteInst(null)}
          onDone={() => {
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
          onDone={() => {
            setRenameInst(null);
            toast('已重命名', 'ok');
            load();
          }}
        />
      )}
      {securityInst && (
        <InstanceSecurity
          inst={securityInst}
          onClose={() => setSecurityInst(null)}
          onDone={() => {
            toast('已保存安全阈值', 'ok');
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
          onDone={load}
        />
      )}
    </div>
  );
}

function RenameInstance({ inst, onClose, onDone }: { inst: InstanceWithStatus; onClose: () => void; onDone: () => void }) {
  const form = useInstanceRename(inst, onDone);
  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={form.submit}>
        <h2>重命名实例</h2>
        <input className="input" placeholder="实例名称" value={form.name} onChange={(e) => form.setName(e.target.value)} autoFocus />
        {form.err && <div className="error">{form.err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!form.canSubmit}>
            保存
          </button>
        </div>
      </form>
    </div>
  );
}

// 「安全」弹窗：编辑某实例的内存安全阀（soft / hard）。
// soft：超过且无人在远程会话时主动重启（柔和自愈，不打扰）
// hard：超过即强制重启（无视会话，防止 OOM）
// 留空 = 使用面板全局默认（来自 env）。
function InstanceSecurity({ inst, onClose, onDone }: { inst: InstanceWithStatus; onClose: () => void; onDone: () => void }) {
  const panel = useInstanceSecurity({ inst, onClose, onDone });

  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={panel.submit} style={{ maxWidth: 460 }}>
        <h2>安全 · {inst.name}</h2>
        {!panel.loaded ? (
          <div className="muted small" style={{ padding: '14px 0' }}>读取中…</div>
        ) : !panel.data ? (
          <div className="error">{panel.err || '读取失败'}</div>
        ) : (
          <>
            <div className="muted small" style={{ lineHeight: 1.6 }}>
              当 KasmVNC/Xvnc 长跑泄漏内存时，面板的 watchdog 会自动重启实例。两档阈值（单位 MiB）：
              <br />
              <b>soft</b>：超过且<b>无人在远程会话</b>时柔和重启（不打扰使用者）。
              <br />
              <b>hard</b>：超过即<b>强制重启</b>，无视会话，防止 OOM 拖垮宿主。
            </div>

            <div className="security-status">
              <div className="security-row">
                <span>当前内存</span>
                <b>{panel.data.currentMB > 0 ? `${panel.data.currentMB} MiB` : '—'}</b>
              </div>
              <div className="security-row">
                <span>面板默认</span>
                <span className="muted">soft {panel.data.defaultSoft} · hard {panel.data.defaultHard}</span>
              </div>
              <div className="security-row">
                <span>巡检间隔</span>
                <span className="muted">
                  {panel.data.watchdogEnabled ? `每 ${panel.data.intervalSec}s` : 'watchdog 已关闭'}
                </span>
              </div>
            </div>

            <div className="field-label" style={{ marginTop: 12 }}>soft 阈值（留空 = 用默认 {panel.data.defaultSoft}）</div>
            <input
              className="input"
              inputMode="numeric"
              placeholder={`${panel.data.defaultSoft}`}
              value={panel.softStr}
              onChange={(e) => panel.setSoftStr(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <div className="field-label" style={{ marginTop: 8 }}>hard 阈值（留空 = 用默认 {panel.data.defaultHard}）</div>
            <input
              className="input"
              inputMode="numeric"
              placeholder={`${panel.data.defaultHard}`}
              value={panel.hardStr}
              onChange={(e) => panel.setHardStr(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <div className="muted small" style={{ marginTop: 6 }}>
              提示：日常活跃内存约 1500 MiB；soft 建议略高于此（如 2000），hard 建议远低于宿主可用内存（如 3000~4000）。
            </div>

            <div className="field-label" style={{ marginTop: 16 }}>设备身份（machine-id）</div>
            <div className="muted small" style={{ lineHeight: 1.6 }}>
              微信会用设备标识做风控。若该账号被判定<b>设备风险</b>、登录后被强制退出且反复循环，
              可重置为一个全新的唯一设备 ID（相当于换台新设备），再重新扫码登录。会重启该实例。
            </div>
            <button
              type="button"
              className="btn"
              style={{ marginTop: 8, alignSelf: 'flex-start' }}
              onClick={panel.regenMachineId}
              disabled={panel.regenBusy || panel.busy}
            >
              {panel.regenBusy ? '重置中…' : '↻ 重置设备 ID 并重启'}
            </button>

            {panel.err && <div className="error">{panel.err}</div>}
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-text" onClick={panel.resetToDefault} disabled={panel.busy}>
            ↺ 恢复默认
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={panel.busy}>
            取消
          </button>
          <button className="btn btn-primary" disabled={panel.busy || !panel.loaded || !panel.data}>
            保存
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteInstance({ inst, onClose, onDone }: { inst: InstanceWithStatus; onClose: () => void; onDone: () => void }) {
  const form = useDeleteInstance(inst, onDone);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
        <h2>删除实例「{inst.name}」？</h2>
        <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          容器会被移除。默认保留聊天记录（数据卷），之后可重建同名实例恢复。
        </div>
        <label className={'purge-opt' + (form.purge ? ' on' : '')} onClick={() => form.setPurge((v) => !v)}>
          <span className="purge-check">{form.purge ? '✓' : ''}</span>
          <span>
            同时永久删除聊天记录（数据卷）
            <span className="muted small" style={{ display: 'block' }}>不可恢复，请谨慎勾选</span>
          </span>
        </label>
        {form.err && <div className="error">{form.err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-danger" disabled={form.busy} onClick={form.submit}>
            {form.purge ? '连数据一起删除' : '删除实例'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 管理页的实例卡片：含微信版本管理（下载/更新）+ 重命名/分配/删除
function InstanceAdminCard({
  inst,
  acting,
  onEnter,
  onTrigger,
  onStart,
  onStop,
  onRestart,
  onUpgrade,
  onRename,
  onIcon,
  onDelete,
  onSecurity,
  onVolume,
  vncKeepAlive,
  onToggleVncKeepAlive,
}: {
  inst: InstanceWithStatus;
  acting?: string;
  onEnter: () => void;
  onTrigger: (inst: InstanceWithStatus, kind: WechatInstallAction) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onUpgrade: () => void;
  onRename: () => void;
  onIcon: () => void;
  onDelete: () => void;
  onSecurity: () => void;
  onVolume: () => void;
  vncKeepAlive: boolean;
  onToggleVncKeepAlive: (enabled: boolean) => void;
}) {
  const wx = inst.wechat;
  const profile = appProfile(inst.appType);
  const { badge, sub, installed, offline, working } = adminCardState(inst, acting);
  const [menuOpen, setMenuOpen] = useState(false); // 「管理」折叠菜单是否展开

  return (
    <div className="inst-card">
      <div className="inst-head">
        <div className="inst-title">
          <span className="inst-avatar">
            <InstanceIcon icon={inst.icon} appType={inst.appType} size={40} radius={12} />
          </span>
          <span className="inst-name">{inst.name}</span>
        </div>
        <span className={'tag ' + badge.cls}>{badge.text}</span>
      </div>
      <div className="inst-sub">
        {sub}
      </div>

      {working && (
        <div className="wx-progress">
          <div
            className={'wx-progress-bar' + (acting || wx.percent < 0 ? ' indeterminate' : '')}
            style={!acting && wx.percent >= 0 ? { width: `${wx.percent}%` } : undefined}
          />
        </div>
      )}

      {/* 进行中（升级/重启/停止/下载）时隐藏所有操作，避免重复点击 */}
      {!working && (
        <>
          <div className="inst-actions">
            {offline ? (
              <button className="btn btn-primary inst-act-wide" onClick={onStart}>
                {inst.runtime === 'missing' ? '创建并启动' : '启动实例'}
              </button>
            ) : (
              <button className="btn btn-primary inst-act-wide" disabled={!installed} onClick={onEnter} title={installed ? '' : profile.installButtonTitle}>
                进入实例
              </button>
            )}
          </div>

          <button className={'inst-menu-toggle' + (menuOpen ? ' open' : '')} onClick={() => setMenuOpen((v) => !v)}>
            <span>管理</span>
            <span className="inst-menu-caret">{Icons.caret}</span>
          </button>

          {menuOpen && (
            <div className="inst-menu">
              <div className="inst-menu-group">
                <div className="inst-menu-label">运维</div>
                <div className="inst-menu-items">
                  {!offline && profile.needsInstall && (
                    <button className="btn-text" onClick={() => onTrigger(inst, installed ? 'update' : 'install')}>
                      {installed ? profile.updateLabel : '下载安装'}
                    </button>
                  )}
                  <button className="btn-text" onClick={onUpgrade} title="拉取最新镜像并重建（保留聊天记录）">
                    升级实例
                  </button>
                  {!offline && (
                    <button className="btn-text" onClick={onRestart}>
                      重启
                    </button>
                  )}
                  {!offline && (
                    <button className="btn-text" onClick={onStop}>
                      停止
                    </button>
                  )}
                </div>
              </div>
              <div className="inst-menu-group">
                <div className="inst-menu-label">设置</div>
                <div className="inst-menu-items">
                  <button className="btn-text" onClick={onRename}>
                    重命名
                  </button>
                  <button className="btn-text" onClick={onIcon} title="设置实例图标">
                    图标
                  </button>
                  <button className="btn-text" onClick={() => window.open(api.instanceLogsUrl(inst.id), '_blank')} title="查看实例容器日志">
                    日志
                  </button>
                  <button className="btn-text" onClick={onSecurity} title="内存阈值自愈">
                    安全
                  </button>
                  <button className="btn-text" onClick={onVolume} title="数据卷：备份/恢复、上传 PC 微信数据、文件管理">
                    数据卷
                  </button>
                  <button
                    className={'btn-text' + (vncKeepAlive ? ' on' : '')}
                    onClick={() => onToggleVncKeepAlive(!vncKeepAlive)}
                    title="切换到主页或管理页时保留该浏览器标签页里的 VNC 连接"
                  >
                    {vncKeepAlive ? 'VNC常驻开' : 'VNC常驻关'}
                  </button>
                </div>
              </div>
              <div className="inst-menu-group inst-menu-danger">
                <div className="inst-menu-items">
                  <button className="btn-text danger" onClick={onDelete}>
                    删除实例
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type CropArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

async function cropToDataUrl(src: string, area: CropArea): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const next = new Image();
    next.onload = () => resolve(next);
    next.onerror = reject;
    next.src = src;
  });
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持图片裁剪');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

function InstanceIconEditor({ inst, onClose, onDone }: { inst: InstanceWithStatus; onClose: () => void; onDone: () => void }) {
  const { toast } = useUI();
  const [selected, setSelected] = useState(inst.icon || '');
  const [busy, setBusy] = useState(false);
  const [cropSrc, setCropSrc] = useState('');
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<CropArea | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('请选择图片文件', 'error');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('图片不能超过 8MB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCropSrc(String(reader.result));
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setArea(null);
    };
    reader.onerror = () => toast('读取图片失败', 'error');
    reader.readAsDataURL(file);
  };

  const confirmCrop = async () => {
    if (!cropSrc || !area) return;
    try {
      setSelected(await cropToDataUrl(cropSrc, area));
      setCropSrc('');
    } catch (error) {
      toast(errorMessage(error, '裁剪失败'), 'error');
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.setInstanceIcon(inst.id, selected || null);
      toast('已保存图标', 'ok');
      onDone();
      onClose();
    } catch (error) {
      toast(errorMessage(error, '保存失败'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="card modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: 460 }}>
        <h2>图标 · {inst.name}</h2>
        {cropSrc ? (
          <>
            <div className="icon-crop">
              <Cropper
                image={cropSrc}
                crop={crop}
                zoom={zoom}
                aspect={1}
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={(_, nextArea) => setArea(nextArea)}
              />
            </div>
            <input className="icon-zoom" type="range" min={1} max={3} step={0.01} value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setCropSrc('')}>
                返回
              </button>
              <button type="button" className="btn btn-primary" onClick={confirmCrop} disabled={!area}>
                裁剪并使用
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="icon-edit-top">
              <InstanceIcon icon={selected || undefined} appType={inst.appType} size={56} radius={14} />
              <div className="muted small">
                {selected.startsWith('data:') ? '自定义图片' : selected.startsWith('builtin:') ? '内置图标' : '应用默认'}
              </div>
            </div>
            <div className="field-label">内置图标</div>
            <div className="icon-grid">
              <button type="button" className={'icon-pick' + (selected === '' ? ' sel' : '')} onClick={() => setSelected('')}>
                <InstanceIcon appType={inst.appType} size={38} radius={11} />
                <span>默认</span>
              </button>
              {ICON_CHOICES.map((choice) => (
                <button
                  type="button"
                  key={choice.key}
                  className={'icon-pick' + (selected === `builtin:${choice.key}` ? ' sel' : '')}
                  onClick={() => setSelected(`builtin:${choice.key}`)}
                >
                  <InstanceIcon icon={`builtin:${choice.key}`} size={38} radius={11} />
                  <span>{choice.label}</span>
                </button>
              ))}
            </div>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              上传图片并裁剪...
            </button>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
                保存
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// 数据卷管理：整卷备份/恢复 + 文件浏览器（浏览/上传/解压/下载/改名/移动/删除）。
// 主要场景：把 PC 微信数据迁移上来、跨实例迁移、离线备份。全程在「运行中」的实例上操作
// （浏览/改名/删除靠 docker exec，需容器运行）。整卷恢复会覆盖全部数据，强提示并建议恢复后重启实例。
function VolumeManager({ inst, onClose, onChanged }: { inst: InstanceWithStatus; onClose: () => void; onChanged: () => void }) {
  const volume = useVolumeManager({ inst, onChanged });
  const icon = (en: VolEntry) => (en.type === 'dir' ? Icons.folder : Icons.file);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="card modal vol-modal" onClick={(e) => e.stopPropagation()}>
        <h2>数据卷 · {inst.name}</h2>

        {/* 整卷备份 / 恢复（运行/停止均可用） */}
        <div className="vol-sec">
            <div className="vol-section-label">整卷备份 / 恢复</div>
            <div className="vol-topbar">
              <a className="btn" href={api.volumeBackupUrl(inst.id)} target="_blank" rel="noreferrer">下载整卷备份</a>
              <button className="btn" disabled={volume.disabled} onClick={() => volume.restoreRef.current?.click()}>恢复备份…</button>
              <input ref={volume.restoreRef} type="file" accept=".gz,.tgz,.tar" hidden onChange={volume.onPick('restore')} />
            </div>
          <div className="vol-hint">整卷含聊天记录，用于跨实例迁移 / 离线备份。</div>
        </div>

        {volume.offline ? (
          <div className="vol-warn">
            实例未运行，文件浏览不可用。可执行上方的整卷备份 / 恢复；要浏览或上传单个文件，请先在卡片上启动实例。
          </div>
        ) : (
          <div className="vol-sec">
            <div className="vol-section-label">文件浏览</div>
            {/* 面包屑 */}
            <div className="vol-crumbs">
              <button className="vol-crumb" disabled={volume.disabled} onClick={() => volume.load('')}>/config</button>
              {volume.segs.map((s, i) => (
                <span key={i}>
                  <span className="vol-sep">/</span>
                  <button className="vol-crumb" disabled={volume.disabled} onClick={() => volume.load(volume.segs.slice(0, i + 1).join('/'))}>
                    {s}
                  </button>
                </span>
              ))}
            </div>

            {/* 工具条 */}
            <div className="vol-tools">
              <button className="btn-text" disabled={volume.disabled} onClick={() => volume.uploadRef.current?.click()}>上传文件</button>
              <button className="btn-text" disabled={volume.disabled} onClick={() => volume.extractRef.current?.click()}>上传并解压</button>
              <button className="btn-text" disabled={volume.disabled} onClick={() => volume.setMkdirOpen((v) => !v)}>新建文件夹</button>
              <button className="btn-text" disabled={volume.disabled} onClick={volume.reload}>刷新</button>
              <input ref={volume.uploadRef} type="file" hidden onChange={volume.onPick('upload')} />
              <input ref={volume.extractRef} type="file" accept=".gz,.tgz,.tar" hidden onChange={volume.onPick('extract')} />
            </div>
            {volume.mkdirOpen && (
              <div className="vol-mkdir">
                <input
                  className="input"
                  placeholder="文件夹名"
                  value={volume.mkdirName}
                  autoFocus
                  onChange={(e) => volume.setMkdirName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && volume.doMkdir()}
                />
                <button className="btn btn-primary" disabled={volume.disabled || !volume.mkdirName.trim()} onClick={volume.doMkdir}>创建</button>
              </div>
            )}

            {volume.busy && <div className="vol-busy">{volume.busy}</div>}

            {/* 文件列表 */}
            <div className="vol-list">
              {volume.loading ? (
                <div className="muted small" style={{ padding: 16 }}>读取中…</div>
              ) : volume.err ? (
                <div className="error">{volume.err}</div>
              ) : volume.sorted.length === 0 ? (
                <div className="muted small" style={{ padding: 16 }}>{volume.path ? '空目录' : '（无内容）'}</div>
              ) : (
                <>
                  {volume.path && (
                    <button className="vol-row vol-main vol-up" disabled={volume.disabled} onClick={() => volume.load(volume.parent)}>
                      <span className="vol-ic">{Icons.folder}</span>
                      <span className="vol-nm">返回上一级</span>
                    </button>
                  )}
                  {volume.sorted.map((en) => (
                    <div className="vol-row" key={en.name}>
                      {volume.renaming === en.name ? (
                        <input
                          className="input vol-rename"
                          autoFocus
                          value={volume.renameVal}
                          onChange={(e) => volume.setRenameVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') volume.doRename(en.name);
                            if (e.key === 'Escape') volume.setRenaming(null);
                          }}
                          onBlur={() => volume.doRename(en.name)}
                        />
                      ) : (
                        <button
                          className="vol-main"
                          disabled={volume.disabled}
                          onClick={() => (en.type === 'dir' ? volume.load(joinVolumePath(volume.path, en.name)) : undefined)}
                          style={{ cursor: en.type === 'dir' ? 'pointer' : 'default' }}
                        >
                          <span className={'vol-ic' + (en.type === 'dir' ? ' dir' : '')}>{icon(en)}</span>
                          <span className="vol-nm">{en.name}</span>
                          <span className="vol-meta">
                            {en.type === 'dir' ? '' : formatBytes(en.size)}
                            {en.mtime ? ` · ${formatDate(en.mtime)}` : ''}
                          </span>
                        </button>
                      )}
                      <div className="vol-acts">
                        {en.type === 'file' && (
                          <a
                            className="vol-act"
                            title="下载"
                            href={api.volumeDownloadUrl(inst.id, joinVolumePath(volume.path, en.name))}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {Icons.download}
                          </a>
                        )}
                        <button
                          className="vol-act"
                          title="重命名 / 移动"
                          disabled={volume.disabled}
                          onClick={() => {
                            volume.setRenameVal(en.name);
                            volume.setRenaming(en.name);
                          }}
                        >
                          {Icons.edit}
                        </button>
                        <button className="vol-act danger" title="删除" disabled={volume.disabled} onClick={() => volume.doDelete(en)}>
                          {Icons.trash}
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        <div className="muted small" style={{ marginTop: 10, lineHeight: 1.6 }}>
          PC 微信数据迁移：把数据文件夹打包成 <b>.tar.gz</b>，用「上传并解压」放到对应目录；改动微信正在使用的数据后，重启实例方可生效。能否解密取决于微信版本与设备绑定，请自行测试。
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function CreateInstance({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const form = useCreateInstance(onDone);

  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={form.submit}>
        <h2>新建实例</h2>
        <div className="field-label">应用类型</div>
        <div className="chip-row" style={{ marginTop: 8, marginBottom: 12 }}>
          {APP_TYPES.map((type) => {
            const profile = appProfile(type);
            return (
              <button
                key={type}
                type="button"
                className={'chip chip-toggle' + (form.appType === type ? ' on' : '')}
                onClick={() => form.setAppType(type)}
              >
                {profile.createLabel}
              </button>
            );
          })}
        </div>
        <input className="input" placeholder="实例名称（如：我的微信 / 工作浏览器）" value={form.name} onChange={(e) => form.setName(e.target.value)} />
        {form.orphans.length > 0 && (
          <>
            <div className="field-label" style={{ marginTop: 12 }}>数据卷（可选）</div>
            <select className="input" value={form.reuse} onChange={(e) => form.setReuse(e.target.value)}>
              <option value="">新建空卷（全新登录）</option>
              {form.orphans.map((v) => (
                <option key={v.name} value={v.name}>
                  复用 · {v.name}
                  {v.createdAt ? `（${v.createdAt.slice(0, 10)} 创建）` : ''}
                </option>
              ))}
            </select>
            <div className="muted small" style={{ marginTop: 4 }}>
              复用旧微信卷需用原微信号扫码登录才能解密历史消息；浏览器实例建议使用新卷。
            </div>
          </>
        )}
        {form.err && <div className="error">{form.err}</div>}
        <div className="muted small" style={{ marginTop: 4 }}>
          创建后会拉起一个新的 {appProfile(form.appType).createLabel} 容器。
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!form.canSubmit}>
            创建
          </button>
        </div>
      </form>
    </div>
  );
}
