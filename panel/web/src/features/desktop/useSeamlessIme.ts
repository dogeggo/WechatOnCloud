import { useEffect, type RefObject } from 'react';
import { api } from '../../api';
import { enableKasmImeMode, installImeCandidateAnchor } from './desktopFrame';

type SeamlessJob = { kind: 'text'; data: string } | { kind: 'key'; data: string };

function installSeamlessIme(win: Window, doc: Document, instanceId: string): () => void {
  const queue: SeamlessJob[] = [];
  let draining = false;
  const active = () => draining || queue.length > 0;

  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const job = queue[0];
      try {
        if (job.kind === 'text') await api.typeInInstance(instanceId, job.data);
        else await api.keyInInstance(instanceId, job.data);
      } catch {
        // 单条失败时丢弃当前任务，避免输入队列永久卡住。
      }
      queue.shift();
    }
    draining = false;
  };

  const onCompositionEnd = (event: Event) => {
    const text = (event as CompositionEvent).data;
    if (!text) return;
    queue.push({ kind: 'text', data: text });
    void drain();
  };

  const onKeyDownCapture = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.isComposing) return;
    if (keyboardEvent.ctrlKey || keyboardEvent.altKey || keyboardEvent.metaKey) return;
    if (!active()) return;

    if (/^[0-9]$/.test(keyboardEvent.key)) {
      keyboardEvent.preventDefault();
      keyboardEvent.stopImmediatePropagation();
      queue.push({ kind: 'text', data: keyboardEvent.key });
      void drain();
      return;
    }

    if (keyboardEvent.key === 'Enter') {
      keyboardEvent.preventDefault();
      keyboardEvent.stopImmediatePropagation();
      queue.push({ kind: 'key', data: 'Return' });
      void drain();
      return;
    }

    if (keyboardEvent.key === 'Backspace') {
      keyboardEvent.preventDefault();
      keyboardEvent.stopImmediatePropagation();
      queue.push({ kind: 'key', data: 'BackSpace' });
      void drain();
    }
  };

  doc.addEventListener('compositionend', onCompositionEnd, true);
  win.addEventListener('keydown', onKeyDownCapture, true);

  return () => {
    doc.removeEventListener('compositionend', onCompositionEnd, true);
    win.removeEventListener('keydown', onKeyDownCapture, true);
  };
}

export function useSeamlessIme({
  active,
  showVnc,
  id,
  frameLoaded,
  frameRef,
}: {
  active: boolean;
  showVnc: boolean;
  id: string | undefined;
  frameLoaded: boolean;
  frameRef: RefObject<HTMLIFrameElement>;
}) {
  useEffect(() => {
    enableKasmImeMode();
  }, []);

  useEffect(() => {
    if (!active || !showVnc || !frameLoaded || !id) return;
    const win = frameRef.current?.contentWindow;
    const doc = frameRef.current?.contentDocument;
    if (!win || !doc) return;
    const cleanupSeamlessIme = installSeamlessIme(win, doc, id);
    const cleanupImeAnchor = installImeCandidateAnchor(doc);
    return () => {
      cleanupImeAnchor();
      cleanupSeamlessIme();
    };
  }, [active, showVnc, frameLoaded, id, frameRef]);
}
