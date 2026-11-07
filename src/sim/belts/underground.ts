/**
 * Underground belt pairing (docs/ARCHITECTURE.md, "Belts: underground
 * belts"): a pure function of positions, directions and modes, shared by the
 * belt table (src/sim/belts/belts.ts) and the renderer's ghost preview.
 *
 * An underground belt is an entrance or an exit, and faces the way items
 * move. An entrance pairs with the nearest underground belt of the same tier
 * (same belt speed) in front of it on the same axis, within `maxGap + 1`
 * tiles, if that one is an exit facing the same way; anything else there (an
 * entrance, or one facing the other way) blocks it. Undergrounds of other
 * tiers, or across the axis, are ignored. An exit looks the same way
 * backwards, so the relation is symmetric: an entrance's partner has it as
 * its partner.
 */

import { DIRECTION_DX, DIRECTION_DY, type Direction } from '../entities/direction';

/** What an underground belt is. Plain belts are `None`. */
export const UndergroundMode = {
  None: 0,
  /** Items go underground here, towards the partner in front. */
  Entrance: 1,
  /** Items come up here and leave through the tile in front. */
  Exit: 2,
} as const;

export type UndergroundMode = (typeof UndergroundMode)[keyof typeof UndergroundMode];

/** An underground belt on a tile, as the pairing sees it. */
export interface UndergroundInfo {
  /** Belt speed of its type: its tier. */
  speed: number;
  dir: Direction;
  mode: UndergroundMode;
}

/** The underground belt on tile `(x, y)`, or `null` (plain belts and anything else count as none). */
export type UndergroundLookup = (x: number, y: number) => UndergroundInfo | null;

/** A partner found by {@link findPartner}: its tile and its distance in tiles (gap + 1). */
export interface PartnerTile {
  x: number;
  y: number;
  distance: number;
}

/**
 * The tile of the partner of an underground belt of tier `speed` on
 * `(x, y)` facing `dir` in mode `mode`, or `null` when it has none.
 */
export function findPartner(
  lookup: UndergroundLookup,
  x: number,
  y: number,
  dir: Direction,
  mode: UndergroundMode,
  speed: number,
  maxGap: number,
): PartnerTile | null {
  if (mode === UndergroundMode.None) return null;
  // An entrance looks ahead, an exit behind.
  const step = mode === UndergroundMode.Entrance ? dir : (dir + 2) & 3;
  const dx = DIRECTION_DX[step]!;
  const dy = DIRECTION_DY[step]!;
  const want = mode === UndergroundMode.Entrance ? UndergroundMode.Exit : UndergroundMode.Entrance;
  for (let k = 1; k <= maxGap + 1; k++) {
    const u = lookup(x + k * dx, y + k * dy);
    if (!u || u.speed !== speed || (u.dir & 1) !== (dir & 1)) continue;
    return u.dir === dir && u.mode === want ? { x: x + k * dx, y: y + k * dy, distance: k } : null;
  }
  return null;
}

/**
 * The mode a new underground belt placed on `(x, y)` facing `dir` gets: an
 * exit when it would pair with an entrance behind it, otherwise an entrance.
 */
export function placedMode(
  lookup: UndergroundLookup,
  x: number,
  y: number,
  dir: Direction,
  speed: number,
  maxGap: number,
): UndergroundMode {
  return findPartner(lookup, x, y, dir, UndergroundMode.Exit, speed, maxGap)
    ? UndergroundMode.Exit
    : UndergroundMode.Entrance;
}
