import { useState, type FormEvent } from 'react';
import { api, type InstanceWithStatus, type PanelInstance } from '../../api';
import { errorMessage } from '../../utils/errors';

export function useInstanceRename(inst: InstanceWithStatus, onDone: (instance: PanelInstance) => void) {
  const [name, setName] = useState(inst.name);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const { instance } = await api.renameInstance(inst.id, name.trim());
      onDone(instance);
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
