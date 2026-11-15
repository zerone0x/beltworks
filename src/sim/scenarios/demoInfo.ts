/**
 * What the main thread needs to know about the demo factory
 * (src/sim/scenarios/demo.ts) without loading its builder: its seed, where it
 * stands (to frame the camera) and where the player waits.
 */

/** The demo's world seed: its four starting ore patches sit where the layout expects them. */
export const DEMO_SEED = 59;

/** The tiles the factory covers (inclusive), for framing the camera. */
export const DEMO_BOUNDS = { x0: -22, y0: -25, x1: 42, y1: 29 } as const;

/** Where the player stands once the factory is built: between the coal drills and the assembly block. */
export const DEMO_SPAWN = { x: 16, y: -8 } as const;
