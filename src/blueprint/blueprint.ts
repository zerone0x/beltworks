/**
 * Blueprints (D59): a list of entities in coordinates relative to the
 * blueprint's top-left corner, with what defines them but not what they hold:
 * the type, the position of the footprint's top-left tile, the direction, an
 * assembling machine's recipe, and whether an underground belt is an entrance
 * or an exit (splitters have no settings yet). Contents, fuel and items on
 * belts are never copied.
 *
 * This module is main-thread data only (no DOM, no simulation state): it
 * captures a blueprint from what the renderer knows (the snapshot's
 * entities and belts), turns it, and plans a paste as the ordinary `Place`,
 * `Rotate` and `SetRecipe` commands a player could send by hand, so the
 * simulation stays deterministic and knows nothing about blueprints.
 */

import type { EntityPrototype } from '../data/entities';
import { isAssemblerRecipe, recipePrototype } from '../data/recipes';
import { UndergroundMode, findPartner, placedMode } from '../sim/belts/underground';
import type { UndergroundInfo, UndergroundLookup } from '../sim/belts/underground';
import type { CommandInput } from '../sim/commands';
import { Direction, rotateClockwise } from '../sim/entities/direction';
import { footprintSize } from '../sim/entities/store';

/** One entity of a blueprint. */
export interface BlueprintEntity {
  readonly proto: EntityPrototype;
  /** Top-left tile of the footprint, relative to the blueprint's top-left corner. */
  readonly x: number;
  readonly y: number;
  /** North for entities that can't rotate. */
  readonly dir: Direction;
  /** An assembling machine's recipe (0 for none, and for every other type). */
  readonly recipe: number;
  /** An underground belt's mode (`UndergroundMode`; `None` for every other type). */
  readonly mode: UndergroundMode;
}

export interface Blueprint {
  /** A name for the library and for shared strings (may be empty). */
  readonly label: string;
  /** Entities sorted by row, then column; their footprints never overlap. */
  readonly entities: readonly BlueprintEntity[];
  /** Size of the bounding box of every footprint, in tiles. */
  readonly width: number;
  readonly height: number;
}

/** Most entities one blueprint may hold (strings with more are refused). */
export const MAX_BLUEPRINT_ENTITIES = 10_000;
/** Largest width or height of a blueprint, in tiles. */
export const MAX_BLUEPRINT_SIZE = 1_000;

/** Whether entities of `proto` take a recipe (the assembling machines). */
export function takesRecipe(proto: EntityPrototype): boolean {
  return proto.craftingSpeed !== undefined;
}

/** Whether `recipe` is one an entity of `proto` can be set to (0, none, always is). */
export function validRecipe(proto: EntityPrototype, recipe: number): boolean {
  if (recipe === 0) return true;
  const r = recipePrototype(recipe);
  return takesRecipe(proto) && r !== undefined && isAssemblerRecipe(r);
}

/** An entity as the capture sees it (an `EntityView` of the renderer fits). */
export interface CaptureSource {
  readonly proto: EntityPrototype | undefined;
  readonly x: number;
  readonly y: number;
  readonly dir: Direction;
  readonly recipe: number;
}

/** A tile rectangle, corners included (`x0 <= x1`, `y0 <= y1`). */
export interface TileBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The box with corners at tiles `a` and `b`, in any order. */
export function boxOf(a: { x: number; y: number }, b: { x: number; y: number }): TileBox {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  };
}

/**
 * A blueprint of `entities` moved so that their bounding box starts at
 * `(0, 0)`, sorted by row then column (`null` for none).
 */
export function normalize(label: string, entities: readonly BlueprintEntity[]): Blueprint | null {
  if (entities.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const e of entities) {
    const { w, h } = footprintSize(e.proto, e.dir);
    x0 = Math.min(x0, e.x);
    y0 = Math.min(y0, e.y);
    x1 = Math.max(x1, e.x + w);
    y1 = Math.max(y1, e.y + h);
  }
  const moved = entities
    .map((e) => ({ ...e, x: e.x - x0, y: e.y - y0 }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return { label, entities: moved, width: x1 - x0, height: y1 - y0 };
}

/**
 * Copies the entities of `sources` whose footprint overlaps `box` into a
 * blueprint (`null` when none does). `undergroundMode(x, y)` tells whether
 * the underground belt on a tile is an entrance or an exit.
 */
export function captureBlueprint(
  sources: Iterable<CaptureSource>,
  box: TileBox,
  undergroundMode: (x: number, y: number) => UndergroundMode,
  label = '',
): Blueprint | null {
  const out: BlueprintEntity[] = [];
  for (const s of sources) {
    const proto = s.proto;
    if (!proto) continue;
    const dir = proto.rotatable ? s.dir : Direction.North;
    const { w, h } = footprintSize(proto, dir);
    if (s.x > box.x1 || s.y > box.y1 || s.x + w - 1 < box.x0 || s.y + h - 1 < box.y0) continue;
    const isUnderground = proto.undergroundMaxGap !== undefined;
    const mode = isUnderground ? undergroundMode(s.x, s.y) : UndergroundMode.None;
    out.push({
      proto,
      x: s.x,
      y: s.y,
      dir,
      recipe: validRecipe(proto, s.recipe) ? s.recipe : 0,
      mode: isUnderground && mode === UndergroundMode.None ? UndergroundMode.Entrance : mode,
    });
  }
  return normalize(label, out);
}

/**
 * The blueprint turned a quarter turn clockwise: every footprint moves to its
 * turned place and every entity that can rotate turns with it (undergrounds
 * keep their mode, so a pair stays a pair; a splitter's two tiles turn
 * across its new direction like any 2×1 footprint).
 */
export function rotateBlueprint(bp: Blueprint): Blueprint {
  const turned = bp.entities.map((e) => {
    const { h } = footprintSize(e.proto, e.dir);
    // Tile (x, y) turns to (-y - 1, x): a footprint's corner (x, y + h) leads.
    return {
      ...e,
      x: -(e.y + h),
      y: e.x,
      dir: e.proto.rotatable ? rotateClockwise(e.dir) : Direction.North,
    };
  });
  return normalize(bp.label, turned)!;
}

/** The blueprint turned `turns` quarter turns clockwise. */
export function rotateBlueprintBy(bp: Blueprint, turns: number): Blueprint {
  let out = bp;
  for (let i = 0; i < ((turns % 4) + 4) % 4; i++) out = rotateBlueprint(out);
  return out;
}

/**
 * The tile the blueprint's top-left corner goes on so that it is centered as
 * closely as possible on world tile position `(tx, ty)` (fractional tiles),
 * like a single entity's ghost.
 */
export function blueprintOrigin(bp: Blueprint, tx: number, ty: number): { x: number; y: number } {
  return {
    x: Math.floor(tx - bp.width / 2 + 0.5),
    y: Math.floor(ty - bp.height / 2 + 0.5),
  };
}

/** Items a blueprint needs, by item id. */
export function blueprintCost(bp: Blueprint): Map<number, number> {
  const cost = new Map<number, number>();
  for (const e of bp.entities) cost.set(e.proto.item, (cost.get(e.proto.item) ?? 0) + 1);
  return cost;
}

/** What a paste needs to know about the world, from the renderer's copy of it. */
export interface PasteWorld {
  /** Whether `proto` facing `dir` can be placed with its top-left tile at `(x, y)` (reach included). */
  canPlace(proto: EntityPrototype, x: number, y: number, dir: Direction): boolean;
  /** Units of `item` in the player's inventory. */
  count(item: number): number;
  /** The underground belts already in the world. */
  undergroundAt: UndergroundLookup;
}

/** Why a blueprint entity isn't placed. */
export type SkipReason = 'blocked' | 'missing';

/** One blueprint entity at its place in the world, as a paste would treat it. */
export interface PlannedEntity {
  readonly proto: EntityPrototype;
  /** Top-left tile in the world. */
  readonly x: number;
  readonly y: number;
  readonly dir: Direction;
  readonly mode: UndergroundMode;
  /** `null` when it is placed; else why not. */
  readonly skip: SkipReason | null;
}

/** An assembling machine's recipe to set once the machine exists (it needs the entity's id). */
export interface PendingRecipe {
  readonly type: number;
  readonly x: number;
  readonly y: number;
  readonly recipe: number;
}

export interface PastePlan {
  /** Every entity of the blueprint, in the order they would be placed. */
  readonly entities: readonly PlannedEntity[];
  /** The commands that place what can be placed. */
  readonly commands: readonly CommandInput[];
  /** Recipes to set on machines once they appear in a snapshot. */
  readonly recipes: readonly PendingRecipe[];
  /** Entities placed, and those skipped as blocked (terrain, others, reach, the player). */
  readonly placed: number;
  readonly blocked: number;
  /** Units missing from the inventory, by item id (what was skipped for lack of items). */
  readonly missing: ReadonlyMap<number, number>;
}

/** How far upstream an underground belt is on its axis: lower comes first when items flow `dir`. */
function upstream(e: BlueprintEntity): number {
  switch (e.dir) {
    case Direction.North:
      return -e.y;
    case Direction.East:
      return e.x;
    case Direction.South:
      return e.y;
    default:
      return -e.x;
  }
}

/**
 * The order to place the blueprint's entities in: everything but
 * underground belts as listed, then the underground belts from upstream to
 * downstream, so that each exit is placed after the entrance it pairs with
 * and a chain of pairs pairs up the same way (an underground belt becomes an
 * exit when placed in front of an entrance, D36).
 */
export function pasteOrder(bp: Blueprint): BlueprintEntity[] {
  const others = bp.entities.filter((e) => e.mode === UndergroundMode.None);
  const undergrounds = bp.entities
    .filter((e) => e.mode !== UndergroundMode.None)
    .sort((a, b) => upstream(a) - upstream(b));
  return [...others, ...undergrounds];
}

const tileKey = (x: number, y: number): string => `${String(x)},${String(y)}`;

/**
 * Plans pasting `bp` with its top-left corner at `(ox, oy)` for player
 * `playerId`: each entity is placed if it can be placed there and the
 * inventory still has its item after the ones before it (D59: what isn't
 * affordable is skipped and reported, there are no ghost entities). Every
 * entity becomes one `Place` command; an underground belt that the
 * placement rule would make the wrong mode (an exit whose entrance isn't
 * pasted, say) is placed reversed and turned back with `Rotate`, which
 * swaps its mode (D36). Recipes are set once the machines exist
 * (`recipes`), since `SetRecipe` names the entity by its id.
 */
export function planPaste(
  bp: Blueprint,
  ox: number,
  oy: number,
  world: PasteWorld,
  playerId: number,
): PastePlan {
  const left = new Map<number, number>();
  const missing = new Map<number, number>();
  const commands: CommandInput[] = [];
  const recipes: PendingRecipe[] = [];
  const entities: PlannedEntity[] = [];
  const pasted = new Map<string, UndergroundInfo>();
  const lookup: UndergroundLookup = (x, y) =>
    pasted.get(tileKey(x, y)) ?? world.undergroundAt(x, y);
  let placed = 0;
  let blocked = 0;
  for (const e of pasteOrder(bp)) {
    const { proto, dir, mode } = e;
    const x = ox + e.x;
    const y = oy + e.y;
    const item = proto.item;
    const have = left.get(item) ?? world.count(item);
    let skip: SkipReason | null = null;
    if (!world.canPlace(proto, x, y, dir)) skip = 'blocked';
    else if (have <= 0) skip = 'missing';
    entities.push({ proto, x, y, dir, mode, skip });
    if (skip === 'blocked') {
      blocked++;
      continue;
    }
    if (skip === 'missing') {
      missing.set(item, (missing.get(item) ?? 0) + 1);
      continue;
    }
    left.set(item, have - 1);
    placed++;
    if (mode === UndergroundMode.None) {
      commands.push({ type: 'Place', playerId, item, x, y, dir });
    } else {
      const speed = proto.beltSpeed ?? 0;
      const gap = proto.undergroundMaxGap ?? 0;
      let got = placedMode(lookup, x, y, dir, speed, gap);
      const back = ((dir + 2) & 3) as Direction;
      const flipped = placedMode(lookup, x, y, back, speed, gap);
      const swapped =
        flipped === UndergroundMode.Entrance ? UndergroundMode.Exit : UndergroundMode.Entrance;
      if (
        got !== mode &&
        swapped === mode &&
        findPartner(lookup, x, y, back, flipped, speed, gap) === null
      ) {
        // Placed facing back it gets the other mode, with no partner to drag along: turn it round.
        commands.push({ type: 'Place', playerId, item, x, y, dir: back });
        commands.push({ type: 'Rotate', playerId, x, y });
        got = mode;
      } else {
        commands.push({ type: 'Place', playerId, item, x, y, dir });
      }
      pasted.set(tileKey(x, y), { speed, dir, mode: got });
    }
    if (e.recipe !== 0) recipes.push({ type: proto.id, x, y, recipe: e.recipe });
  }
  return { entities, commands, recipes, placed, blocked, missing };
}
