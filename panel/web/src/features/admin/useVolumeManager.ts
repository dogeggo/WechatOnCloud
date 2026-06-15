import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, type InstanceWithStatus, type VolEntry } from '../../api';
import { joinVolumePath, normalizeMoveTarget, parentVolumePath, sortVolumeEntries, splitVolumePath } from '../../domain/volumePaths';
import { useUI } from '../../ui';
import { errorMessage } from '../../utils/errors';

type PickKind = 'upload' | 'extract' | 'restore';

export function useVolumeManager({
  inst,
  onChanged,
}: {
  inst: InstanceWithStatus;
  onChanged: () => void;
}) {
  const { toast, confirm } = useUI();
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<VolEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [renaming, setRenamingState] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const renamingRef = useRef<string | null>(null);
  const renameSubmittingRef = useRef(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const extractRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);
  const offline = inst.runtime !== 'running';

  const setRenaming = useCallback((name: string | null) => {
    renamingRef.current = name;
    if (name) renameSubmittingRef.current = false;
    setRenamingState(name);
  }, []);

  const load = useCallback(
    async (nextPath: string) => {
      setLoading(true);
      setErr('');
      try {
        const result = await api.volumeList(inst.id, nextPath);
        setEntries(result.entries);
        setPath(result.path);
      } catch (error) {
        setErr(errorMessage(error, '读取失败'));
      } finally {
        setLoading(false);
      }
    },
    [inst.id],
  );

  const reload = useCallback(() => load(path), [load, path]);

  useEffect(() => {
    if (offline) {
      setLoading(false);
      return;
    }
    void load('');
  }, [load, offline]);

  const run = async (label: string, action: () => Promise<unknown>, okMsg?: string, skipReload = false) => {
    setBusy(label);
    try {
      await action();
      if (okMsg) toast(okMsg, 'ok');
      if (!skipReload) await reload();
    } catch (error) {
      toast(errorMessage(error, '操作失败'), 'error');
    } finally {
      setBusy('');
    }
  };

  const doMkdir = async () => {
    const name = mkdirName.trim();
    if (!name) return;
    await run('新建中...', () => api.volumeMkdir(inst.id, joinVolumePath(path, name)), '已新建文件夹');
    setMkdirName('');
    setMkdirOpen(false);
  };

  const doRename = async (oldName: string) => {
    if (renameSubmittingRef.current || renamingRef.current !== oldName) return;
    const nextName = renameVal.trim();
    renameSubmittingRef.current = true;
    setRenaming(null);
    if (!nextName || nextName === oldName) {
      renameSubmittingRef.current = false;
      return;
    }
    try {
      await run(
        '处理中...',
        () => api.volumeMove(inst.id, joinVolumePath(path, oldName), normalizeMoveTarget(path, nextName)),
        '已重命名 / 移动',
      );
    } finally {
      renameSubmittingRef.current = false;
    }
  };

  const doDelete = async (entry: VolEntry) => {
    const ok = await confirm({
      title: `删除「${entry.name}」？`,
      body: entry.type === 'dir' ? '将递归删除该文件夹下所有内容，不可恢复。' : '删除后不可恢复。',
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    await run('删除中...', () => api.volumeDelete(inst.id, joinVolumePath(path, entry.name)), '已删除');
  };

  const onPick = (kind: PickKind) => async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (kind === 'restore') {
      const ok = await confirm({
        title: '恢复整卷备份？',
        body: `将用「${file.name}」覆盖该实例 /config 的全部数据（含登录态、聊天库），不可撤销。建议仅用于本系统导出的备份；恢复后请在卡片上「重启」实例以加载数据。`,
        danger: true,
        confirmText: '覆盖恢复',
      });
      if (!ok) return;
      await run(`恢复 ${file.name}...`, () => api.volumeRestore(inst.id, file), '恢复完成，请重启实例以加载数据', true);
      onChanged();
      return;
    }
    if (kind === 'upload') {
      await run(`上传 ${file.name}...`, () => api.volumeUpload(inst.id, path, file), '上传完成');
      return;
    }
    await run(`解压 ${file.name}...`, () => api.volumeExtract(inst.id, path, file), '解压完成');
  };

  return {
    path,
    entries,
    sorted: sortVolumeEntries(entries),
    parent: parentVolumePath(path),
    segs: splitVolumePath(path),
    loading,
    err,
    busy,
    disabled: !!busy,
    mkdirOpen,
    setMkdirOpen,
    mkdirName,
    setMkdirName,
    renaming,
    setRenaming,
    renameVal,
    setRenameVal,
    uploadRef,
    extractRef,
    restoreRef,
    offline,
    load,
    reload,
    doMkdir,
    doRename,
    doDelete,
    onPick,
  };
}
