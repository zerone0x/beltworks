/**
 * Audio volumes (D55): the `audio` part of the player settings (D50,
 * src/ui/settings.ts), in percent (0–100), which main.ts hands to
 * `AudioEngine.setVolumes` at startup and on every change.
 */

import { DEFAULT_SETTINGS, type AudioSettings, type SettingsStore } from '../ui/settings';

export type { AudioSettings };

/** The volumes before the settings are applied: the settings' defaults. */
export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = DEFAULT_SETTINGS.audio;

/**
 * Linear gain for a volume in percent. Squared, so a slider feels even: half
 * way is a quarter of the amplitude (about −12 dB), not barely quieter.
 */
export function volumeToGain(percentValue: number): number {
  const v = Math.min(100, Math.max(0, percentValue)) / 100;
  return v * v;
}

/**
 * Gives `engine` the settings' volumes now and again on every change to the
 * settings, so the sliders take effect at once; returns the unsubscribe.
 */
export function followVolumeSettings(
  engine: { setVolumes(volumes: AudioSettings): void },
  settings: Pick<SettingsStore, 'value' | 'subscribe'>,
): () => void {
  engine.setVolumes(settings.value.audio);
  return settings.subscribe((next, previous) => {
    const a = next.audio;
    const b = previous.audio;
    if (a.master !== b.master || a.sfx !== b.sfx || a.music !== b.music) engine.setVolumes(a);
  });
}
