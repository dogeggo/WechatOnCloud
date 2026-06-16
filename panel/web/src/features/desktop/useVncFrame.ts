import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { VncAudio } from '../../vncAudio';
import { startProbeWatchdog } from '../../utils/connectionWatchdog';
import { isVncKeepAliveEnabled } from '../../vncKeepAlive';
import {
  applyVncStreamSettings,
  blurVncFrame,
  focusVncFrame,
  injectVncStyle,
  isVncFrameDisconnected,
  readDesktopInputMode,
  writeKasmImeMode,
} from './desktopFrame';
import type { VncStreamSettings } from '../../domain/vncStream';

export function useVncFrame({
  active,
  showVnc,
  id,
  frameRef,
  stream,
}: {
  active: boolean;
  showVnc: boolean;
  id: string | undefined;
  frameRef: RefObject<HTMLIFrameElement>;
  stream: VncStreamSettings;
}) {
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [loadStuck, setLoadStuck] = useState(false);
  const [vncNonce, setVncNonce] = useState(0);
  const activeRef = useRef(active);

  const focusFrame = useCallback(() => focusVncFrame(frameRef.current), [frameRef]);

  const reconnect = useCallback(() => {
    setLoadStuck(false);
    setFrameLoaded(false);
    setVncNonce((nonce) => nonce + 1);
  }, []);

  const reconnectIfDisconnected = useCallback(() => {
    if (!id || !showVnc || !frameLoaded) return false;
    if (!active && !isVncKeepAliveEnabled(id)) return false;
    if (!isVncFrameDisconnected(frameRef.current)) return false;
    reconnect();
    return true;
  }, [active, frameLoaded, frameRef, id, reconnect, showVnc]);

  const handleFrameLoad = useCallback(() => {
    setFrameLoaded(true);
    window.setTimeout(() => {
      if (active) focusVncFrame(frameRef.current);
      injectVncStyle(frameRef.current);
      applyVncStreamSettings(frameRef.current, stream);
    }, 500);
  }, [active, frameRef, stream]);

  useEffect(() => {
    setFrameLoaded(false);
    setLoadStuck(false);
  }, [id]);

  useEffect(() => {
    setLoadStuck(false);
    if (!showVnc || frameLoaded) return;
    const timer = window.setTimeout(() => setLoadStuck(true), 12000);
    return () => window.clearTimeout(timer);
  }, [showVnc, frameLoaded, id, vncNonce]);

  useEffect(() => {
    writeKasmImeMode(readDesktopInputMode());
  }, [id, vncNonce]);

  useEffect(() => {
    if (!active || !showVnc || !frameLoaded) return;
    const timer = window.setTimeout(() => {
      focusVncFrame(frameRef.current);
      injectVncStyle(frameRef.current);
      applyVncStreamSettings(frameRef.current, stream);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [active, showVnc, frameLoaded, id, frameRef, stream]);

  useEffect(() => {
    if (!showVnc || !frameLoaded) return;
    applyVncStreamSettings(frameRef.current, stream);
  }, [frameLoaded, frameRef, showVnc, stream]);

  useEffect(() => {
    const wasActive = activeRef.current;
    activeRef.current = active;
    if (!active || wasActive) return;
    reconnectIfDisconnected();
  }, [active, reconnectIfDisconnected]);

  useEffect(() => {
    if (!showVnc || !frameLoaded || !id) return;
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    const onPointerDown = () => reconnectIfDisconnected();
    doc.addEventListener('pointerdown', onPointerDown, true);
    return () => doc.removeEventListener('pointerdown', onPointerDown, true);
  }, [frameLoaded, frameRef, id, reconnectIfDisconnected, showVnc]);

  useEffect(() => {
    if (!showVnc || !frameLoaded || !id) return;
    if (!active && !isVncKeepAliveEnabled(id)) return;
    return startProbeWatchdog({
      name: `vnc:${id}`,
      intervalMs: active ? 5000 : 10000,
      probe: () => {
        reconnectIfDisconnected();
      },
    });
  }, [active, frameLoaded, id, reconnectIfDisconnected, showVnc]);

  useEffect(() => {
    if (active) return;
    blurVncFrame(frameRef.current);
  }, [active, frameRef]);

  useEffect(() => {
    if (!active || !showVnc || !id) return;
    if (!stream.audio) return;
    const audio = new VncAudio(id);
    void audio.connect();
    const isFocused = () => !document.hidden && document.hasFocus();
    const sync = () => audio.setActive(isFocused());
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      audio.destroy();
    };
  }, [active, showVnc, id, stream.audio]);

  return {
    frameLoaded,
    loadStuck,
    vncNonce,
    reconnect,
    reconnectIfDisconnected,
    focusFrame,
    handleFrameLoad,
  };
}
