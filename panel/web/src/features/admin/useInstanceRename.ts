import { useState, type FormEvent } from 'react';
import { api, type InstanceWithStatus } from '../../api';
import { errorMessage } from '../../utils/errors';

export function useInstanceRename(inst: InstanceWithStatus, onDone: () => void) {
  const [name, setName] = useState(inst.name);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.renameInstance(inst.id, name.trim());
      onDone();
    } catch (error) {
      setErr(errorMessage(error, '重命名失败'));
    } finally {
      setBusy(false);
    }
  };

  return {
    name,
    setName,
    err,
    busy,
    canSubmit: !busy && !!name.trim() && name.trim() !== inst.name,
    submit,
  };
}
