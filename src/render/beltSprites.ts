/**
 * Which sprites draw a belt (docs/ART.md, "Belts"): the moving surface
 * (`belt-surface`, the same for every tier), the side frames in the tier
 * color (the belt prototype's own model) and, on an underground belt, the
 * hood over its closed half (`<underground prototype>:entrance` / `:exit`).
 * Curves use the models with a `:curve-left` / `:curve-right` suffix.
 *
 * The surface animates with the belt itself, not with a clock: its frames
 * cover one slat pitch (`BELT_SLATS` slats per tile), and the frame shown is
 * how far the belt has moved, so the slats run at exactly the speed of the
 * items on it, whatever the tier.
 *
 * Read-only: nothing here flows back into the simulation.
 */

import { BeltShape } from '../sim/belts/belts';
import { UndergroundMode } from '../sim/belts/underground';
import { modelLayer, type ModelLayer, type ModelSprites, type SpriteAtlas } from './sprites';

/** Slats per tile on the belt surface; its animation loops over one slat (art/blender/models/belts.py). */
export const BELT_SLATS = 4;
/** The surface model (tier-independent). */
export const BELT_SURFACE = 'belt-surface';

/** The model name suffix of a belt shape. */
export function shapeSuffix(shape: number): string {
  if (shape === BeltShape.CurveFromLeft) return ':curve-left';
  if (shape === BeltShape.CurveFromRight) return ':curve-right';
  return '';
}

/**
 * The surface frame (of `count`) of a belt that has moved `travelTiles`
 * tiles since tick 0.
 */
export function surfaceFrame(count: number, travelTiles: number): number {
  if (count <= 1) return 0;
  const slats = travelTiles * BELT_SLATS;
  const f = Math.floor((slats - Math.floor(slats)) * count);
  return Math.min(count - 1, Math.max(0, f));
}

/** The sprites of one belt: its moving surface, its side frames and an underground's hood. */
export interface BeltSprites {
  surface: ModelLayer;
  surfaceModel: ModelSprites;
  frame: ModelSprites;
  /** The hood of an underground belt; `null` for a plain belt. */
  hood: ModelSprites | null;
}

/**
 * The sprites of a belt of prototype `name` (its tier's transport belt for
 * an underground belt, `UNDERGROUND_TIER`) with shape `shape` and
 * underground mode `mode`, or `null` when the atlas doesn't have them all.
 */
export function beltSprites(
  atlas: SpriteAtlas | null,
  name: string | undefined,
  shape: number,
  mode: number = UndergroundMode.None,
): BeltSprites | null {
  if (!atlas || name === undefined) return null;
  const underground = mode !== UndergroundMode.None;
  const suffix = underground ? '' : shapeSuffix(shape);
  const surfaceModel = atlas.model(BELT_SURFACE + suffix);
  const surface = surfaceModel && modelLayer(surfaceModel, 'surface');
  const tier = underground ? (UNDERGROUND_TIER[name] ?? null) : name;
  const frame = tier === null ? null : atlas.model(tier + suffix);
  const hood = underground
    ? atlas.model(`${name}:${mode === UndergroundMode.Exit ? 'exit' : 'entrance'}`)
    : null;
  if (!surfaceModel || !surface || !frame || (underground && !hood)) return null;
  return { surface, surfaceModel, frame, hood };
}

/** The transport belt whose side frames each underground belt shows, by prototype name. */
export const UNDERGROUND_TIER: Readonly<Record<string, string>> = {
  'underground-belt': 'transport-belt',
  'fast-underground-belt': 'fast-transport-belt',
  'express-underground-belt': 'express-transport-belt',
};
