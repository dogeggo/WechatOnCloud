import { useEffect, useState, type RefObject } from 'react';
import { useUI } from '../../ui';
import { pullClipboardFromRemote, pushClipboardToRemote } from './desktopFrame';

export function useClipboardBridge({
  id,
  frameRef,
}: {
  id: string | undefined;
  frameRef: RefObject<HTMLIFrameElement>;
}) {
  const { toast } = useUI();
  const [showClip, setShowClip] = useState(false);
  const [clipText, setClipText] = useState('');

  useEffect(() => {
    setShowClip(false);
    setClipText('');
  }, [id]);

  const sendClip = () => {
    if (!clipText) {
      toast('请先输入要发送的文本', 'error');
      return;
    }
    if (pushClipboardToRemote(frameRef.current, clipText)) {
      toast('已发送到容器剪贴板，请在应用输入框按 Ctrl+V 粘贴', 'ok');
      return;
    }
    toast('发送失败：桌面尚未连接', 'error');
  };

  const pullClip = () => {
    const text = pullClipboardFromRemote(frameRef.current);
    if (text == null) {
      toast('读取失败：桌面尚未连接', 'error');
      return;
    }
    setClipText(text);
    toast('已读取容器剪贴板', 'ok');
  };

  return {
    showClip,
    setShowClip,
    clipText,
    setClipText,
    sendClip,
    pullClip,
  };
}
