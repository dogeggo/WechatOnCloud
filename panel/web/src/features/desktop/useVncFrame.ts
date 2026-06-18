import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { VncAudio } from '../../vncAudio';
import { startProbeWatchdog } from '../../utils/connectionWatchdog';
import { isVncKeepAliveEnabled } from '../../vncKeepAlive';
import {
  applyVncStreamSettings,
  blurVncFrame,
  enableKasmImeMode,
  focusVncFrame,
  injectVncStyle,
  isVncFrameDisconnected,
  requestVncFullRefresh,
  syncVncFrameSize,
} from './desktopFrame';
import type { VncStreamSettings } from '../../domain/vncStream';

const INACTIVE_VNC_STREAM_SETTINGS = {
  quality: 2,
  compression: 9,
  dynamicQualityMin: 1,
  dynamicQualityMax: 3,
  treatLossless: 5,
  jpegVideoQuality: 2,
  webpVideoQuality: 2,
  videoQuality: 10,
  videoArea: 25,
  videoTime: 2,
  videoOutTime: 1,
  videoScaling: 0,
  maxVideoResolutionX: 640,
  maxVideoResolutionY: 360,
  frameRate: 8,
  enableWebP: true,
} as const;

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
  const frameStream = active ? stream : INACTIVE_VNC_STREAM_SETTINGS;

  const syncFrame = useCallback((shouldFocus: boolean) => {
    if (shouldFocus) focusVncFrame(frameRef.current);
    injectVncStyle(frameRef.current);
    applyVncStreamSettings(frameRef.current, shouldFocus ? stream : INACTIVE_VNC_STREAM_SETTINGS);
    if (shouldFocus) syncVncFrameSize(frameRef.current);
  }, [frameRef, stream]);

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
      syncFrame(active);
    }, 500);
  }, [active, syncFrame]);

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
    enableKasmImeMode();
  }, [id, vncNonce]);

  useEffect(() => {
    if (!active || !showVnc || !frameLoaded) return;
    const timers = [80, 260, 700].map((delay) => window.setTimeout(() => syncFrame(true), delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [active, showVnc, frameLoaded, id, syncFrame]);

  useEffect(() => {
    if (!showVnc || !frameLoaded) return;
    const applied = applyVncStreamSettings(frameRef.current, frameStream);
    if (active && applied) requestVncFullRefresh(frameRef.current);
  }, [active, frameLoaded, frameRef, frameStream, showVnc]);

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
