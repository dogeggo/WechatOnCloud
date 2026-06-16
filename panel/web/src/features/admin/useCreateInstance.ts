import { useEffect, useState, type FormEvent } from 'react';
import { api, type AppType, type OrphanVolume } from '../../api';
import { errorMessage } from '../../utils/errors';

export function useCreateInstance(onDone: () => void, allowReuseVolume: boolean, initialReuseVolume = '') {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [orphans, setOrphans] = useState<OrphanVolume[]>([]);
  const [reuse, setReuse] = useState(initialReuseVolume);
  const [appType, setAppType] = useState<AppType>('wechat');
  const selectedVolume = orphans.find((volume) => volume.name === reuse);
  const lockedAppType = selectedVolume?.appType;

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
        if (!alive) return;
        setOrphans(volumes);
        const initialVolume = volumes.find((volume) => volume.name === initialReuseVolume);
        if (initialVolume?.appType) setAppType(initialVolume.appType);
      })
      .catch((error) => {
        if (alive) setErr(errorMessage(error, '读取未使用数据卷失败'));
      });
    return () => {
      alive = false;
    };
  }, [allowReuseVolume, initialReuseVolume]);

  useEffect(() => {
    if (lockedAppType && appType !== lockedAppType) {
      setAppType(lockedAppType);
    }
  }, [appType, lockedAppType]);

  const selectReuse = (value: string) => {
    setReuse(value);
    const volume = orphans.find((item) => item.name === value);
    if (volume?.appType) setAppType(volume.appType);
  };

  const selectAppType = (value: AppType) => {
    if (lockedAppType && value !== lockedAppType) return;
    setAppType(value);
  };

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
    setReuse: selectReuse,
    selectedVolume,
    lockedAppType,
    appType,
    setAppType: selectAppType,
    canSubmit: !busy && !!name.trim() && (!reuse || !!lockedAppType) && (!lockedAppType || appType === lockedAppType),
    submit,
  };
}
