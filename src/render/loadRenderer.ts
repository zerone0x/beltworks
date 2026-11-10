/**
 * Loads the renderer's code (renderer.ts: PixiJS, the game view, the art
 * loaders) in the background (D64). The title screen shows without it; the
 * game waits for it once the player picked what to play.
 */

/** What renderer.ts exports. */
export type Renderer = typeof import('./renderer');

/**
 * The renderer's code couldn't be downloaded or run: offline, a dropped
 * connection, or a new release replaced the files this page refers to.
 */
export class RendererLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RendererLoadError';
  }
}

/**
 * Starts downloading the renderer's code. The promise rejects with a
 * `RendererLoadError`, and doesn't count as unhandled before someone awaits
 * it (the game does once the title screen resolves).
 */
export function loadRenderer(): Promise<Renderer> {
  const renderer = import('./renderer').catch((err: unknown) => {
    throw new RendererLoadError(err);
  });
  renderer.catch(() => undefined);
  return renderer;
}
