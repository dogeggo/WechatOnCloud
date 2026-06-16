import { useEffect, useState, type FormEvent } from 'react';
import { api, type AppType, type OrphanVolume } from '../../api';
import { errorMessage } from '../../utils/errors';

export function useCreateInstance(onDone: () => void, allowReuseVolume: boolean) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [orphans, setOrphans] = useState<OrphanVolume[]>([]);
  const [reuse, setReuse] = useState('');
  const [appType, setAppType] = useState<AppType>('wechat');

  useEffect(() => {
    if (!allowReuseVolume) {
      setOrphans([]);
      setReuse('');
      return;
    }
    let alive = true;
    api
      .listOrphanVolumes()
      .then(({ volumes }) => {
        if (alive) setOrphans(volumes);
      })
      .catch((error) => {
        if (alive) setErr(errorMessage(error, '读取未使用数据卷失败'));
      });
    return () => {
      alive = false;
    };
  }, [allowReuseVolume]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.createInstance(name.trim(), allowReuseVolume ? reuse || undefined : undefined, appType);
      onDone();
    } catch (error) {
      setErr(errorMessage(error, '创建失败'));
    } finally {
      setBusy(false);
    }
  };

  return {
    name,
    setName,
    err,
    busy,
    orphans,
    reuse,
    setReuse,
    appType,
    setAppType,
    canSubmit: !busy && !!name.trim(),
    submit,
  };
}
