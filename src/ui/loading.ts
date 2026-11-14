/**
 * "Loading the game…" between the title screen and the game (plain DOM,
 * D39), for while the renderer's code is still downloading (D64). Shown only
 * if the wait is long enough to notice, so a fast load doesn't flash it.
 */

import { OVERLAY_STYLE } from './gameMenu';

/** Milliseconds before the note shows. */
const SHOW_AFTER_MS = 250;

/** A status note in the middle of the screen, over nothing (plain DOM). */
export function statusNote(id: string, text: string): HTMLElement {
  const note = document.createElement('div');
  note.id = id;
  note.setAttribute('role', 'status');
  note.textContent = text;
  Object.assign(note.style, OVERLAY_STYLE, {
    background: 'none',
    pointerEvents: 'none',
    color: '#e8e2d0',
    font: '15px/1.5 system-ui, sans-serif',
  });
  document.body.append(note);
  return note;
}

/**
 * Resolves (or rejects) like `work`, with the loading note on screen while it
 * takes long; with `note` false, without (another note says what is going on).
 */
export async function whileLoading<T>(work: Promise<T>, note = true): Promise<T> {
  let shown: HTMLElement | null = null;
  const timer = note
    ? setTimeout(() => {
        shown = statusNote('loading-game', 'Loading the game…');
      }, SHOW_AFTER_MS)
    : undefined;
  try {
    return await work;
  } finally {
    clearTimeout(timer);
    (shown as HTMLElement | null)?.remove();
  }
}
