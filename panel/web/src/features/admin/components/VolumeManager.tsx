import { api, type InstanceWithStatus, type VolEntry } from '../../../api';
import { Icons } from '../../../components/icons';
import { joinVolumePath } from '../../../domain/volumePaths';
import { formatBytes, formatDate } from '../../../utils/format';
import { useVolumeManager } from '../useVolumeManager';

export function VolumeManager({
  inst,
  onClose,
  onChanged,
}: {
  inst: InstanceWithStatus;
  onClose: () => void;
  onChanged: () => void;
}) {
  const volume = useVolumeManager({ inst, onChanged });
  const icon = (en: VolEntry) => (en.type === 'dir' ? Icons.folder : Icons.file);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="card modal vol-modal" onClick={(e) => e.stopPropagation()}>
        <h2>数据卷 · {inst.name}</h2>

        <div className="vol-sec">
          <div className="vol-section-label">整卷备份 / 恢复</div>
          <div className="vol-topbar">
            <a className="btn" href={api.volumeBackupUrl(inst.id)} target="_blank" rel="noreferrer">下载整卷备份</a>
            <button className="btn" disabled={volume.disabled} onClick={() => volume.restoreRef.current?.click()}>恢复备份…</button>
            <input ref={volume.restoreRef} type="file" accept=".gz,.tgz,.tar" hidden onChange={volume.onPick('restore')} />
          </div>
          <div className="vol-hint">整卷含登录态、聊天记录和缓存，用于跨实例迁移 / 离线备份。</div>
        </div>

        {volume.offline ? (
          <div className="vol-warn">
            实例未运行，文件浏览不可用。可执行上方的整卷备份 / 恢复；要浏览或上传单个文件，请先在卡片上启动实例。
          </div>
        ) : (
          <div className="vol-sec">
            <div className="vol-section-label">文件浏览</div>
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
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              e.currentTarget.blur();
                            }
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
          PC 应用数据迁移：把数据文件夹打包成 <b>.tar.gz</b>，用「上传并解压」放到对应目录；改动应用正在使用的数据后，重启实例方可生效。能否解密取决于客户端版本、账号和设备绑定，请自行测试。
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
