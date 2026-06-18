import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_VNC_STREAM_SETTINGS,
  isVncStreamSettingsKey,
  normalizeVncStreamSettings,
  readVncStreamSettings,
  type VncStreamProfile,
  VNC_STREAM_SETTINGS_EVENT,
  type VncStreamSettingsChange,
  type VncStreamSettings,
  VNC_STREAM_PROFILES,
  writeVncStreamSettings,
} from '../../domain/vncStream';

export function useVncStreamSettings() {
  const [settings, setSettings] = useState<VncStreamSettings>(() => readVncStreamSettings());

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<VncStreamSettingsChange>).detail;
      if (detail?.settings) setSettings(detail.settings);
    };
    const onStorage = (event: StorageEvent) => {
      if (!isVncStreamSettingsKey(event.key)) return;
      setSettings(readVncStreamSettings());
    };
    window.addEventListener(VNC_STREAM_SETTINGS_EVENT, onChanged as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(VNC_STREAM_SETTINGS_EVENT, onChanged as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setProfile = useCallback((profile: VncStreamProfile): VncStreamSettings | null => {
    const option = VNC_STREAM_PROFILES.find((item) => item.profile === profile);
    if (!option) return null;
    return writeVncStreamSettings(option.settings);
  }, []);

  const update = useCallback((next: Partial<VncStreamSettings>) => {
    const settings = normalizeVncStreamSettings({ ...readVncStreamSettings(), ...next });
    writeVncStreamSettings(settings);
  }, []);

  const reset = useCallback(() => {
    writeVncStreamSettings(DEFAULT_VNC_STREAM_SETTINGS);
  }, []);

  return {
    settings,
    setSettings: update,
    setProfile,
    reset,
  };
}
