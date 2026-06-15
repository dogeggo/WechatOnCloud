import { useState } from 'react';
import { api, type InstanceWithStatus } from '../../api';
import { errorMessage } from '../../utils/errors';

export function useDeleteInstance(inst: InstanceWithStatus, onDone: () => void) {
  const [purge, setPurge] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      await api.deleteInstance(inst.id, purge);
      onDone();
    } catch (error) {
      setErr(errorMessage(error, '删除失败'));
      setBusy(false);
    }
  };

  return {
    purge,
    setPurge,
    err,
    busy,
    submit,
  };
}
