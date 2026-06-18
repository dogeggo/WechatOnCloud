import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_VNC_STREAM_SETTINGS,
  normalizeVncStreamSettings,
  readVncStreamSettings,
  type VncStreamProfile,
  type VncStreamSettings,
  VNC_STREAM_PROFILES,
  writeVncStreamSettings,
} from '../../domain/vncStream';

export function useVncStreamSettings() {
  const [settings, setSettings] = useState<VncStreamSettings>(() => readVncStreamSettings());

  useEffect(() => {
    writeVncStreamSettings(settings);
  }, [settings]);

  const setProfile = useCallback((profile: VncStreamProfile): VncStreamSettings | null => {
    const option = VNC_STREAM_PROFILES.find((item) => item.profile === profile);
    if (!option) return null;
    setSettings(option.settings);
    return option.settings;
  }, []);

  const update = useCallback((next: Partial<VncStreamSettings>) => {
    setSettings((current) => normalizeVncStreamSettings({ ...current, ...next }));
  }, []);

  const reset = useCallback(() => {
    setSettings(DEFAULT_VNC_STREAM_SETTINGS);
  }, []);

  return {
    settings,
    setSettings: update,
    setProfile,
    reset,
  };
}
