/**
 * The promo footage of the demo factory (docs/TOOLING.md, "Promo capture"):
 * one shot per stage of the production line, the highlight reel cut from
 * them, the README clip and the stills. Positions are in tiles (the demo's
 * layout, src/sim/scenarios/demo.ts), zooms as the game's camera has them.
 */

/**
 * @typedef {{ x: number, y: number, zoom: number }} CameraKey
 * @typedef {object} Shot
 * @property {string} name File name (`a-wide`, ...).
 * @property {string} title What the shot shows.
 * @property {number} seconds Length at 60 fps.
 * @property {CameraKey} from The camera on the first frame.
 * @property {CameraKey} to The camera on the last frame (eased in and out between).
 * @property {number} [ticksPerFrame] Simulation ticks per frame: 1 is real time.
 * @property {number} [untilUnits] Before the shot, run the game on (unrecorded) until
 *   the research has at least this many units done.
 * @property {boolean} [untilResearched] Record until the research completes (then
 *   `holdSeconds` more), up to `seconds`.
 * @property {number} [holdSeconds]
 * @property {boolean} [hudVariant] Also record the minimal-HUD variant (the research bar).
 * @property {{ x: number, y: number }} [openPole] Open the power panel of the pole on this tile.
 * @property {number} [still] Which frame (0..1 of the shot) to keep as a high-resolution still.
 */

/** @type {Shot[]} */
export const SHOTS = [
  {
    name: 'a-wide',
    title: 'The whole factory, slowly zooming out',
    seconds: 8,
    from: { x: 5, y: 0, zoom: 1.0 },
    to: { x: 5, y: 0, zoom: 0.78 },
    hudVariant: true,
    still: 1,
  },
  {
    name: 'b-drills',
    title: 'Electric drills on the iron patch, ore flowing onto the belt',
    seconds: 7,
    from: { x: -15, y: -15.5, zoom: 2.1 },
    to: { x: -8, y: -15.5, zoom: 2.1 },
    still: 0.5,
  },
  {
    name: 'c-furnaces',
    title: 'The iron furnaces smelting, plates leaving on both sides',
    seconds: 7,
    from: { x: 0.5, y: -12, zoom: 1.7 },
    to: { x: 0.5, y: -10, zoom: 2.2 },
    still: 0.6,
  },
  {
    name: 'd-assemblers',
    title: 'Assembling machines making gears, circuits and science, inserters swinging',
    seconds: 8,
    from: { x: 12, y: 0.5, zoom: 1.9 },
    to: { x: 20, y: 0.5, zoom: 1.9 },
    still: 0.4,
  },
  {
    name: 'e-science-belts',
    title: 'Red packs under the bus, onto the green packs belt, through the splitters',
    seconds: 8,
    from: { x: 10, y: 1, zoom: 1.8 },
    to: { x: 22, y: 12, zoom: 1.8 },
    still: 0.7,
  },
  // The README clip's two views: the camera stands still, so a GIF of them stays small.
  {
    name: 'r-factory',
    title: 'README clip: the whole factory (still camera)',
    seconds: 7,
    from: { x: 5, y: -0.5, zoom: 0.8 },
    to: { x: 5, y: -0.5, zoom: 0.8 },
    hudVariant: true,
  },
  {
    name: 'r-science',
    title: 'README clip: the assembly block, science and labs (still camera)',
    seconds: 6,
    from: { x: 19.5, y: 5, zoom: 1.35 },
    to: { x: 19.5, y: 5, zoom: 1.35 },
    hudVariant: true,
  },
  {
    name: 'f-labs',
    title: 'Labs using both packs: automation 2 completes, and logistics starts',
    seconds: 14,
    from: { x: 23, y: 11.5, zoom: 2.0 },
    to: { x: 23.5, y: 12, zoom: 2.2 },
    untilUnits: 34,
    untilResearched: true,
    holdSeconds: 5,
    hudVariant: true,
    still: 0.15,
  },
  {
    name: 'g-power',
    title: 'The steam power plant, with its network panel',
    seconds: 7,
    from: { x: 27, y: -1, zoom: 1.4 },
    to: { x: 28, y: 0, zoom: 1.6 },
    openPole: { x: 28, y: 0 },
    still: 0.8,
  },
];

/**
 * The highlight reel: `[shot, from second, seconds]`, cut together in this
 * order (about 40 s).
 * @type {[string, number, number][]}
 */
export const REEL = [
  ['a-wide', 0, 6],
  ['b-drills', 1, 5],
  ['c-furnaces', 1, 5],
  ['d-assemblers', 1, 6],
  ['e-science-belts', 1, 6],
  ['f-labs', 0, 9],
  ['g-power', 1, 5],
];

/**
 * The README clip (docs/demo-factory.gif): a short loop of two still views
 * (with the research bar), the whole factory and then its science, small
 * enough to embed.
 * @type {[string, number, number][]}
 */
export const README_CLIP = [
  ['r-factory', 0, 7],
  ['r-science', 0, 6],
];

/** Ease in and out (a half cosine): 0 at 0, 1 at 1, flat at both ends. */
export const ease = (/** @type {number} */ t) =>
  (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t)))) / 2;

/**
 * The camera `t` (0..1) of the way through a shot: position eased linearly,
 * zoom eased on a log scale (a steady push-in or pull-out looks even).
 * @param {Shot} shot
 * @param {number} t
 * @returns {CameraKey}
 */
export function cameraAt(shot, t) {
  const e = ease(t);
  const { from, to } = shot;
  return {
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
    zoom: Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e),
  };
}
