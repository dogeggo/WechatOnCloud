import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../../api';
import { useUI } from '../../ui';
import { errorMessage } from '../../utils/errors';

export interface DesktopControl {
  free: boolean;
  mine: boolean;
  holder: string | null;
}

const CONTROL_EVENTS = ['mousedown', 'keydown', 'wheel'] as const;

export function useDesktopControl({
  active,
  showVnc,
  id,
  frameLoaded,
  frameRef,
  focusFrame,
}: {
  active: boolean;
  showVnc: boolean;
  id: string | undefined;
  frameLoaded: boolean;
  frameRef: RefObject<HTMLIFrameElement>;
  focusFrame: () => void;
}) {
  const { toast } = useUI();
  const [control, setControl] = useState<DesktopControl | null>(null);
  const lastBeat = useRef(0);
  const pollErrorReported = useRef(false);

  useEffect(() => {
    if (!active || !showVnc || !id) {
      setControl(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const result = await api.controlStatus(id);
        if (!alive) return;
        pollErrorReported.current = false;
        setControl(result);
        if (!result.free && !result.mine) frameRef.current?.blur();
      } catch (error) {
        if (!pollErrorReported.current) {
          pollErrorReported.current = true;
          toast(errorMessage(error, '读取控制权失败'), 'error');
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [active, showVnc, id, frameRef, toast]);

  useEffect(() => {
    if (!active || !showVnc || !id || !frameLoaded) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const onInteract = async () => {
      const now = Date.now();
      if (now - lastBeat.current < 2500) return;
      lastBeat.current = now;
      try {
        const result = await api.controlBeat(id);
        setControl({ free: false, mine: result.mine, holder: result.holder });
      } catch (error) {
        toast(errorMessage(error, '续约控制权失败'), 'error');
      }
    };
    const addOptions: AddEventListenerOptions = { capture: true, passive: true };
    const removeOptions: EventListenerOptions = { capture: true };
    CONTROL_EVENTS.forEach((eventName) => win.addEventListener(eventName, onInteract, addOptions));
    return () => {
      CONTROL_EVENTS.forEach((eventName) => win.removeEventListener(eventName, onInteract, removeOptions));
    };
  }, [active, showVnc, id, frameLoaded, frameRef, toast]);

  const ensureControl = useCallback(async (): Promise<boolean> => {
    if (!id) return false;
    try {
      const result = await api.controlBeat(id);
      setControl({ free: false, mine: result.mine, holder: result.holder });
      lastBeat.current = Date.now();
      if (!result.mine) {
        toast(`「${result.holder}」正在操作，请先申请控制`, 'error');
        return false;
      }
      return true;
    } catch (error) {
      toast(errorMessage(error, '申请控制失败'), 'error');
      return false;
    }
  }, [id, toast]);

  const takeControl = useCallback(async () => {
    if (!id) return;
    try {
      const result = await api.controlTake(id);
      setControl({ free: false, mine: result.mine, holder: result.holder });
      lastBeat.current = Date.now();
      focusFrame();
    } catch (error) {
      toast(errorMessage(error, '接管失败'), 'error');
    }
  }, [focusFrame, id, toast]);

  return {
    control,
    ensureControl,
    takeControl,
  };
}
