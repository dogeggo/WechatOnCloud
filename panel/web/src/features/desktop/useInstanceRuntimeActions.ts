import { useCallback, useState } from 'react';
import { api } from '../../api';
import { useUI } from '../../ui';
import { errorMessage } from '../../utils/errors';

export function useInstanceRuntimeActions({
  id,
  reload,
  reconnect,
}: {
  id: string | undefined;
  reload: () => Promise<void>;
  reconnect: () => void;
}) {
  const { toast, confirm } = useUI();
  const [starting, setStarting] = useState(false);

  const restartInstance = useCallback(async () => {
    if (!id) return;
    const ok = await confirm({
      title: '重启该实例？',
      body: '会重建容器（聊天记录保留），微信重新启动，约十几秒；用于修复卡死/最小化丢失等。',
      confirmText: '重启',
    });
    if (!ok) return;
    try {
      await api.instanceRestart(id);
      toast('已重启，正在重连...', 'ok');
      reconnect();
      await reload();
    } catch (error) {
      toast(errorMessage(error, '重启失败'), 'error');
    }
  }, [confirm, id, reconnect, reload, toast]);

  const start = useCallback(async () => {
    if (!id) return;
    setStarting(true);
    try {
      await api.instanceStart(id);
      toast('实例已启动', 'ok');
      await reload();
    } catch (error) {
      toast(errorMessage(error, '启动失败'), 'error');
    } finally {
      setStarting(false);
    }
  }, [id, reload, toast]);

  return {
    starting,
    start,
    restartInstance,
  };
}
