import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type InstanceWithStatus } from '../../api';
import { isAppBusy } from '../../domain/instances';
import { useUI } from '../../ui';
import { errorMessage } from '../../utils/errors';

export interface InstancesState {
  instances: InstanceWithStatus[];
  loaded: boolean;
  reload: () => Promise<void>;
}

export function useInstancesLoader(): InstancesState {
  const { toast } = useUI();
  const [instances, setInstances] = useState<InstanceWithStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      const result = await api.listInstances();
      setInstances(result.instances);
    } catch (error) {
      toast(errorMessage(error, '读取实例列表失败'), 'error');
    } finally {
      setLoaded(true);
    }
  }, [toast]);

  useEffect(() => {
    void reload();
    return () => window.clearTimeout(timer.current);
  }, [reload]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (instances.some((inst) => isAppBusy(inst.app.phase))) {
      timer.current = window.setTimeout(() => void reload(), 1500);
    }
    return () => window.clearTimeout(timer.current);
  }, [instances, reload]);

  return { instances, loaded, reload };
}
