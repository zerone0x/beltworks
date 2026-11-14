/**
 * What the main thread needs to know about the demo factory
 * (src/sim/scenarios/demo.ts) without loading its builder: its seed, where it
 * stands (to frame the camera) and where the player waits.
 */

/** The demo's world seed: its four starting ore patches sit where the layout expects them. */
export const DEMO_SEED = 59;

/** The tiles the factory covers (inclusive), for framing the camera. */
export const DEMO_BOUNDS = { x0: -19, y0: -23, x1: 46, y1: 19 } as const;

/** Where the player stands once the factory is built: on the bus's north side, by the middle. */
export const DEMO_SPAWN = { x: 12, y: -5 } as const;
