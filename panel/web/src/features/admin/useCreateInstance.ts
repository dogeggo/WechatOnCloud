import { useEffect, useState, type FormEvent } from 'react';
import { api, type OrphanVolume } from '../../api';
import { errorMessage } from '../../utils/errors';

export function useCreateInstance(onDone: () => void) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [orphans, setOrphans] = useState<OrphanVolume[]>([]);
  const [reuse, setReuse] = useState('');

  useEffect(() => {
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
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.createInstance(name.trim(), reuse || undefined);
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
    canSubmit: !busy && !!name.trim(),
    submit,
  };
}
