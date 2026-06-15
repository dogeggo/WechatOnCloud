import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useUI } from '../../ui';
import { errorMessage } from '../../utils/errors';
import { readImeSubmitKey, writeImeSubmitKey, type ImeSubmitKey } from './desktopFrame';

export function useImeComposer({
  id,
  controlLocked,
  ensureControl,
  focusFrame,
}: {
  id: string | undefined;
  controlLocked: boolean;
  ensureControl: () => Promise<boolean>;
  focusFrame: () => void;
}) {
  const { toast } = useUI();
  const [imeBar, setImeBar] = useState(true);
  const [imeText, setImeText] = useState('');
  const [imeSending, setImeSending] = useState<'input' | 'send' | null>(null);
  const [imeSubmitKey, setImeSubmitKey] = useState<ImeSubmitKey>(() => readImeSubmitKey());

  useEffect(() => {
    setImeText('');
  }, [id]);

  useEffect(() => {
    try {
      writeImeSubmitKey(imeSubmitKey);
    } catch (error) {
      toast(errorMessage(error, '保存发送快捷键失败'), 'error');
    }
  }, [imeSubmitKey, toast]);

  const sendImeText = async (submit: boolean) => {
    if (!imeText.trim() || !id || imeSending) return;
    setImeSending(submit ? 'send' : 'input');
    try {
      if (!(await ensureControl())) return;
      focusFrame();
      await api.typeInInstance(id, imeText, { submit, submitKey: imeSubmitKey });
      setImeText('');
    } catch (error) {
      toast(errorMessage(error, '发送失败：请确认实例已「升级实例」（镜像含 xclip/xdotool）'), 'error');
    } finally {
      setImeSending(null);
    }
  };

  return {
    imeBar,
    setImeBar,
    imeText,
    setImeText,
    imeSending,
    imeSubmitKey,
    setImeSubmitKey,
    imeDisabled: !!imeSending || controlLocked,
    sendImeText,
  };
}
