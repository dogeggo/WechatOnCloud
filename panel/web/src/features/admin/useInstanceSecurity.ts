import { useEffect, useState, type FormEvent } from 'react';
import { api, type InstanceWithStatus, type MemLimits, type PanelInstance } from '../../api';
import { parseOptionalMiB, validateMemLimits } from '../../domain/memoryLimits';
import { useUI } from '../../ui';
import { errorMessage } from '../../utils/errors';

export function useInstanceSecurity({
  inst,
  onClose,
  onDone,
}: {
  inst: InstanceWithStatus;
  onClose: () => void;
  onDone: (instance?: PanelInstance) => void;
}) {
  const { toast, confirm } = useUI();
  const [data, setData] = useState<MemLimits | null>(null);
  const [softStr, setSoftStr] = useState('');
  const [hardStr, setHardStr] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const fetchOnce = async (initial: boolean) => {
      try {
        const next = await api.getInstanceMemLimits(inst.id);
        if (!alive) return;
        setData(next);
        if (initial) {
          setSoftStr(next.soft == null ? '' : String(next.soft));
          setHardStr(next.hard == null ? '' : String(next.hard));
          setLoaded(true);
        }
      } catch (error) {
        if (alive && initial) {
          setErr(errorMessage(error, '读取失败'));
          setLoaded(true);
        }
      }
    };
    void fetchOnce(true);
    const timer = window.setInterval(() => void fetchOnce(false), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [inst.id]);

  const regenMachineId = async () => {
    const ok = await confirm({
      title: '重置该实例的设备 ID？',
      body: '会生成一个全新的设备标识（machine-id）并重启实例，相当于"换一台新设备"。需要重新扫码或重新登录。适用于账号被客户端判定设备风险、登录即被强制退出的情况。',
      danger: true,
      confirmText: '重置并重启',
    });
    if (!ok) return;
    setRegenBusy(true);
    try {
      await api.regenMachineId(inst.id);
      toast('已重置设备 ID，实例正在重启，请稍后重新登录', 'ok');
      onClose();
      onDone();
    } catch (error) {
      toast(errorMessage(error, '重置失败'), 'error');
    } finally {
      setRegenBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErr('');
    let soft: number | null;
    let hard: number | null;
    try {
      soft = parseOptionalMiB(softStr);
      hard = parseOptionalMiB(hardStr);
      validateMemLimits(soft, hard, data?.hardMax ?? null);
    } catch (error) {
      setErr(errorMessage(error, '阈值格式错误'));
      return;
    }

    setBusy(true);
    try {
      const { instance } = await api.setInstanceMemLimits(inst.id, soft, hard);
      onDone(instance);
      onClose();
    } catch (error) {
      setErr(errorMessage(error, '保存失败'));
    } finally {
      setBusy(false);
    }
  };

  return {
    data,
    softStr,
    setSoftStr,
    hardStr,
    setHardStr,
    err,
    busy,
    loaded,
    regenBusy,
    regenMachineId,
    resetToDefault: () => {
      setSoftStr('');
      setHardStr('');
    },
    submit,
  };
}
