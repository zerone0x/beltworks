/**
 * "Loading the game…" between the title screen and the game (plain DOM,
 * D39), for while the renderer's code is still downloading (D64). Shown only
 * if the wait is long enough to notice, so a fast load doesn't flash it.
 */

import { OVERLAY_STYLE } from './gameMenu';

/** Milliseconds before the note shows. */
const SHOW_AFTER_MS = 250;

/** Resolves (or rejects) like `work`, with the loading note on screen while it takes long. */
export async function whileLoading<T>(work: Promise<T>): Promise<T> {
  let note: HTMLElement | null = null;
  const timer = setTimeout(() => {
    note = document.createElement('div');
    note.id = 'loading-game';
    note.setAttribute('role', 'status');
    note.textContent = 'Loading the game…';
    Object.assign(note.style, OVERLAY_STYLE, {
      background: 'none',
      pointerEvents: 'none',
      color: '#e8e2d0',
      font: '15px/1.5 system-ui, sans-serif',
    });
    document.body.append(note);
  }, SHOW_AFTER_MS);
  try {
    return await work;
  } finally {
    clearTimeout(timer);
    (note as HTMLElement | null)?.remove();
  }
}
