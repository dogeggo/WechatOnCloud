import { useCallback, useState } from 'react';
import { api } from '../../api';
import { useUI } from '../../ui';
import { errorMessage } from '../../utils/errors';

export function useInstanceRuntimeActions({
  id,
  reload,
}: {
  id: string | undefined;
  reload: () => Promise<void>;
}) {
  const { toast } = useUI();
  const [starting, setStarting] = useState(false);

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
  };
}
