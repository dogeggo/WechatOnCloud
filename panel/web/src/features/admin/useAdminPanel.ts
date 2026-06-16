import { useCallback, useEffect, useState } from 'react';
import { api, type InstanceWithStatus, type LoggedInDevice, type OrphanContainer, type OrphanVolume, type PanelInstance } from '../../api';
import {
  lifecycleBusyLabel,
  lifecycleDoneMessage,
  type LifecycleAction,
  type AppInstallAction,
  appActionDoneMessage,
} from '../../domain/instances';
import { deviceName } from '../../domain/devices';
import { errorMessage } from '../../utils/errors';
import { useAuth } from '../../auth';
import { useInstances } from '../instances/instances-context';
import { isVncKeepAliveEnabled, setVncKeepAliveEnabled } from '../../vncKeepAlive';
import { useUI } from '../../ui';

function patchActionLabel(actions: Record<string, string>, id: string, label: string | null): Record<string, string> {
  const next = { ...actions };
  if (label) next[id] = label;
  else delete next[id];
  return next;
}

export function useAdminPanel() {
  const { toast, confirm } = useUI();
  const { user } = useAuth();
  const { instances, reload: reloadInstances, updateInstances } = useInstances();
  const isAdmin = !!user?.isAdmin;
  const [devices, setDevices] = useState<LoggedInDevice[]>([]);
  const [orphanVolumes, setOrphanVolumes] = useState<OrphanVolume[]>([]);
  const [orphanContainers, setOrphanContainers] = useState<OrphanContainer[]>([]);
  const [vncKeepAlive, setVncKeepAlive] = useState<Record<string, boolean>>({});
  const [acting, setActing] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');

  const setAct = useCallback((id: string, label: string | null) => {
    setActing((actions) => patchActionLabel(actions, id, label));
  }, []);

  useEffect(() => {
    setVncKeepAlive(Object.fromEntries(instances.map((inst) => [inst.id, isVncKeepAliveEnabled(inst.id)])));
  }, [instances]);

  const refreshOrphanVolumes = useCallback(async () => {
    if (!isAdmin) {
      setOrphanVolumes([]);
      return;
    }
    const { volumes } = await api.listOrphanVolumes();
    setOrphanVolumes(volumes);
  }, [isAdmin]);

  const load = useCallback(async (refreshInstances = true) => {
    setErr('');
    const tasks = [
      refreshInstances ? reloadInstances() : Promise.resolve(),
      api.listLoggedInDevices().then(({ devices }) => setDevices(devices)),
      refreshOrphanVolumes(),
      isAdmin
        ? api.listOrphanContainers().then(({ containers }) => setOrphanContainers(containers))
        : Promise.resolve(setOrphanContainers([])),
    ];
    const results = await Promise.allSettled(tasks);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) setErr(errorMessage(rejected.reason, '读取管理数据失败'));
  }, [isAdmin, refreshOrphanVolumes, reloadInstances]);

  useEffect(() => {
    void load();
  }, [load]);

  const removeDevice = useCallback(
    async (device: LoggedInDevice) => {
      const ok = await confirm({
        title: device.current ? '移除当前设备？' : `移除「${deviceName(device.userAgent)}」？`,
        body: device.current
          ? '当前浏览器会立即退出登录，需要重新 OIDC 登录后才能继续访问面板。'
          : '该设备上的面板登录态会失效；如果仍在使用，下次操作时会回到登录页。',
        danger: true,
        confirmText: device.current ? '移除并退出' : '移除设备',
      });
      if (!ok) return;
      try {
        const result = await api.removeLoggedInDevice(device.id);
        toast(device.current || result.current ? '已移除当前设备' : '已移除登录设备', 'ok');
        if (device.current || result.current) {
          window.location.assign('/login');
          return;
        }
        setDevices((list) => list.filter((item) => item.id !== device.id));
      } catch (error) {
        toast(errorMessage(error, '移除失败'), 'error');
      }
    },
    [confirm, toast],
  );

  const removeOrphanContainer = useCallback(
    async (container: OrphanContainer) => {
      const ok = await confirm({
        title: `删除残留容器「${container.name}」？`,
        body: '此容器不属于任何登记实例。删除不会动数据卷，删后才能继续清理同名旧数据卷。',
        danger: true,
        confirmText: '删除容器',
      });
      if (!ok) return;
      try {
        await api.deleteOrphanContainer(container.id);
        toast('已删除残留容器，可继续清理数据卷', 'ok');
        setOrphanContainers((containers) => containers.filter((item) => item.id !== container.id));
        await refreshOrphanVolumes();
      } catch (error) {
        toast(errorMessage(error, '删除失败'), 'error');
      }
    },
    [confirm, refreshOrphanVolumes, toast],
  );

  const removeOrphanVolume = useCallback(
    async (name: string) => {
      const ok = await confirm({
        title: `彻底删除数据卷「${name}」？`,
        body: '该卷里保存的应用本地数据（聊天记录、登录态、缓存等）将永久消失，无法恢复。',
        danger: true,
        confirmText: '彻底删除',
      });
      if (!ok) return;
      try {
        await api.deleteOrphanVolume(name);
        toast('已删除数据卷', 'ok');
        setOrphanVolumes((volumes) => volumes.filter((volume) => volume.name !== name));
      } catch (error) {
        toast(errorMessage(error, '删除失败'), 'error');
      }
    },
    [confirm, toast],
  );

  const triggerAppInstall = useCallback(
    async (inst: InstanceWithStatus, action: AppInstallAction) => {
      try {
        if (action === 'install') await api.instanceAppInstall(inst.id);
        else await api.instanceAppUpdate(inst.id);
        const updatedAt = Math.floor(Date.now() / 1000);
        updateInstances((list) =>
          list.map((item) =>
            item.id === inst.id
              ? { ...item, app: { ...item.app, phase: 'downloading', percent: -1, message: '正在准备...', updatedAt } }
              : item,
          ),
        );
        toast(appActionDoneMessage(action, inst.appType), 'ok');
      } catch (error) {
        toast(errorMessage(error, '操作失败'), 'error');
      }
    },
    [toast, updateInstances],
  );

  const forgetInstance = useCallback(
    (id: string) => updateInstances((list) => list.filter((item) => item.id !== id)),
    [updateInstances],
  );

  const patchInstance = useCallback(
    (instance: PanelInstance) =>
      updateInstances((list) =>
        list.map((item) => (item.id === instance.id ? { ...item, ...instance } : item)),
      ),
    [updateInstances],
  );

  const startInstance = useCallback(
    async (inst: InstanceWithStatus) => {
      setAct(inst.id, '启动中...');
      try {
        await api.instanceStart(inst.id);
        toast('实例已启动', 'ok');
        await load();
      } catch (error) {
        toast(errorMessage(error, '启动失败'), 'error');
      } finally {
        setAct(inst.id, null);
      }
    },
    [load, setAct, toast],
  );

  const runLifecycle = useCallback(
    async (inst: InstanceWithStatus, action: LifecycleAction) => {
      setAct(inst.id, lifecycleBusyLabel(action));
      if (action === 'upgrade') toast('正在升级实例：拉取最新镜像并重建，可能需要几分钟，请勿离开...', 'info');
      try {
        if (action === 'stop') await api.instanceStop(inst.id);
        else if (action === 'upgrade') await api.instanceUpgrade(inst.id);
        else await api.instanceRestart(inst.id);
        toast(lifecycleDoneMessage(action), 'ok');
        await load();
      } catch (error) {
        toast(errorMessage(error, '操作失败'), 'error');
      } finally {
        setAct(inst.id, null);
      }
    },
    [load, setAct, toast],
  );

  const toggleVncKeepAlive = useCallback(
    (inst: InstanceWithStatus, enabled: boolean) => {
      try {
        setVncKeepAliveEnabled(inst.id, enabled);
        setVncKeepAlive((prefs) => ({ ...prefs, [inst.id]: enabled }));
        toast(enabled ? '已开启 VNC 常驻' : '已关闭 VNC 常驻', 'ok');
      } catch (error) {
        toast(errorMessage(error, '保存 VNC 常驻设置失败'), 'error');
      }
    },
    [toast],
  );

  return {
    isAdmin,
    instances,
    forgetInstance,
    patchInstance,
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
    triggerAppInstall,
    startInstance,
    runLifecycle,
    toggleVncKeepAlive,
  };
}
