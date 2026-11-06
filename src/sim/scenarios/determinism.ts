/**
 * The scripted scenario behind the determinism test. It runs in Node (Vitest)
 * and in Chromium (Playwright, through the dev/test hook), and both compare
 * the resulting hash against the same expected value in
 * tests/sim/determinism.expected.ts.
 *
 * The script has two phases:
 * 1. Scripted (ticks `[0, DETERMINISM_SCRIPTED_TICKS)`): player 0 builds at
 *    the spawn (places, rotates and removes entities, fuels a furnace, lays a
 *    belt line through a curve with a side-loading belt and drops coal on it,
 *    with an unfuelled inserter at its end that refuels itself from the coal
 *    and moves the rest into a chest, plus build and transfer commands that
 *    must be ignored), then every player
 *    walks from the spawn to one of the starting ore patches and hand-mines
 *    it, including a re-target, mining that waits until the player is in
 *    reach, and walking out of reach while mining. Player 0 then builds a
 *    furnace and a chest on its (iron) patch, smelts the ore it mined, and
 *    moves plates into the chest; the furnace keeps smelting into phase 2.
 *    It also sets up a drill on the patch that mines into a chest placed in
 *    front of it once the first ore is waiting, and keeps mining into phase 2.
 *    Meanwhile the players hand-craft from the plates, wood and stone of
 *    `DETERMINISM_KIT`: crafts with auto-queued intermediates, crafts cut
 *    short by missing items, and cancels (of a craft, of an intermediate in
 *    progress, and of nothing).
 * 2. Random: a pseudo-random but fixed stream of every command type for the
 *    remaining ticks.
 */

import { ItemId, type ItemStack } from '../../data/items';
import { RecipeId } from '../../data/recipes';
import { STARTING_KIT } from '../../data/start';
import type { Axis, Command } from '../commands';
import { Direction } from '../entities/direction';
import { FurnaceSlot } from '../entities/furnace';
import { HALF_TILE, fixedToTile, tileToFixed } from '../fixed';
import { PLAYER_DIAGONAL_SPEED, PLAYER_SPEED } from '../player';
import { Rng } from '../rng';
import { Sim } from '../tick';
import { startingPatches } from '../world/generate';

export const DETERMINISM_SEED = 0x5eed_2026;
export const DETERMINISM_SCRIPT_SEED = 0xc0ffee;
export const DETERMINISM_TICKS = 10_000;
export const DETERMINISM_PLAYERS = 3;
/** Length of the scripted walk-and-mine phase; random commands start after it. */
export const DETERMINISM_SCRIPTED_TICKS = 1_000;

const AXES: readonly Axis[] = [-1, 0, 1];
/** Random `Place` and `Insert` commands use item ids in `[0, ITEM_ID_SPAN)`. */
const ITEM_ID_SPAN = 16;
/** Random `Insert` and `Take` commands target entity ids in `[0, ENTITY_ID_SPAN)`. */
const ENTITY_ID_SPAN = 16;
/** Random `Craft` commands use recipe ids in `[0, RECIPE_ID_SPAN)`. */
const RECIPE_ID_SPAN = 11;

/** What every player starts with: the normal starting kit plus materials to craft from. */
export const DETERMINISM_KIT: readonly ItemStack[] = [
  ...STARTING_KIT,
  { item: ItemId.IronPlate, count: 30 },
  { item: ItemId.Wood, count: 4 },
  { item: ItemId.Stone, count: 10 },
];

interface Walker {
  readonly playerId: number;
  tick: number;
  /** Position in subtiles. */
  x: number;
  y: number;
}

const sign = (v: number): Axis => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * Appends the `Move` commands that walk `w` close to `(toX, toY)` (subtiles):
 * diagonally first, then straight along each axis, then stop. Mirrors the
 * player system's integer movement exactly; the path must be free of water,
 * which holds around the spawn (it is flattened to grass).
 */
function walkTo(commands: Command[], w: Walker, toX: number, toY: number): void {
  const step = (dx: Axis, dy: Axis, speed: number, ticks: number): void => {
    if (ticks <= 0) return;
    commands.push({ tick: w.tick, playerId: w.playerId, type: 'Move', dx, dy });
    w.x += dx * speed * ticks;
    w.y += dy * speed * ticks;
    w.tick += ticks;
  };
  const diagonal = Math.min(
    Math.floor(Math.abs(toX - w.x) / PLAYER_DIAGONAL_SPEED),
    Math.floor(Math.abs(toY - w.y) / PLAYER_DIAGONAL_SPEED),
  );
  step(sign(toX - w.x), sign(toY - w.y), PLAYER_DIAGONAL_SPEED, diagonal);
  step(sign(toX - w.x), 0, PLAYER_SPEED, Math.floor(Math.abs(toX - w.x) / PLAYER_SPEED));
  step(0, sign(toY - w.y), PLAYER_SPEED, Math.floor(Math.abs(toY - w.y) / PLAYER_SPEED));
  commands.push({ tick: w.tick, playerId: w.playerId, type: 'Move', dx: 0, dy: 0 });
}

/** Ticks player 0 spends building at the spawn before it walks off. */
export const DETERMINISM_BUILD_TICKS = 8;

/**
 * Player 0's build commands at the spawn, where it stands on tiles
 * (-1..0, -1..0). Those marked "ignored" must not change any state.
 */
function buildPhase(): Command[] {
  const p = { playerId: 0 };
  const { North, East, West } = Direction;
  return [
    // Ignored: the player stands there; iron ore places nothing.
    { ...p, tick: 0, type: 'Place', item: ItemId.WoodenChest, x: 0, y: 0, dir: North },
    { ...p, tick: 0, type: 'Place', item: ItemId.IronOre, x: 3, y: 3, dir: North },
    { ...p, tick: 1, type: 'Place', item: ItemId.WoodenChest, x: 2, y: -2, dir: North },
    // A 2×2 furnace on (3..4, 0..1); the direction of a non-rotatable entity is dropped.
    { ...p, tick: 1, type: 'Place', item: ItemId.StoneFurnace, x: 3, y: 0, dir: West },
    // Ignored: overlaps the furnace.
    { ...p, tick: 2, type: 'Place', item: ItemId.StoneFurnace, x: 4, y: 1, dir: North },
    { ...p, tick: 2, type: 'Place', item: ItemId.TransportBelt, x: 1, y: 2, dir: East },
    // Ignored: out of reach.
    { ...p, tick: 3, type: 'Place', item: ItemId.TransportBelt, x: 15, y: 0, dir: North },
    { ...p, tick: 3, type: 'Rotate', x: 1, y: 2 },
    // Ignored: furnaces don't rotate.
    { ...p, tick: 4, type: 'Rotate', x: 4, y: 1 },
    { ...p, tick: 4, type: 'Remove', x: 2, y: -2 },
    // Ignored: nothing there.
    { ...p, tick: 5, type: 'Remove', x: 9, y: 9 },
    // A drill at negative coordinates, and an inserter next to it.
    { ...p, tick: 5, type: 'Place', item: ItemId.BurnerMiningDrill, x: -3, y: 1, dir: West },
    { ...p, tick: 6, type: 'Place', item: ItemId.BurnerInserter, x: -1, y: 2, dir: East },
    { ...p, tick: 7, type: 'Rotate', x: -2, y: 2 },
    // The furnace (entity 2) gets coal in its fuel slot, and gives one back.
    { ...p, tick: 3, type: 'Insert', entity: 2, item: ItemId.Coal, count: 4 },
    // One coal onto the belt (entity 3): it runs south to the end of the belt.
    { ...p, tick: 4, type: 'Insert', entity: 3, item: ItemId.Coal, count: 1 },
    { ...p, tick: 6, type: 'Take', entity: 2, slot: FurnaceSlot.Fuel, count: 1 },
    // Ignored: entity 1 is gone; iron plates neither burn nor smelt.
    { ...p, tick: 7, type: 'Insert', entity: 1, item: ItemId.Coal, count: 1 },
    { ...p, tick: 7, type: 'Insert', entity: 2, item: ItemId.IronPlate, count: 1 },
    // A belt line (entities 6–10) continuing the belt at (1, 2): south, a curve
    // at (1, 4) turning east, then east to (3, 4). The belt at (2, 5) points
    // north into its side and side-loads its right lane; it gets one coal (on its
    // right lane), and the belt at (1, 2) joins the line now that (1, 3) continues it.
    ...DETERMINISM_BELTS.map(([x, y, dir]): Command => ({
      ...p,
      tick: 7,
      type: 'Place',
      item: ItemId.TransportBelt,
      x,
      y,
      dir,
    })),
    { ...p, tick: 7, type: 'Insert', entity: 10, item: ItemId.Coal, count: 1 },
    // An inserter (entity 11) at the end of the line, without fuel, taking from
    // the belt at (3, 4) into a chest (entity 12): it fuels itself with the
    // first coal that arrives and moves the second into the chest.
    { ...p, tick: 7, type: 'Place', item: ItemId.BurnerInserter, x: 4, y: 4, dir: East },
    { ...p, tick: 7, type: 'Place', item: ItemId.WoodenChest, x: 5, y: 4, dir: North },
  ];
}

/** The inserter and chest at the end of the spawn belt line. */
export const DETERMINISM_SPAWN_INSERTER = 11;
export const DETERMINISM_SPAWN_CHEST = 12;

/** The belts player 0 lays at the spawn on its last build tick: `[x, y, dir]`. */
export const DETERMINISM_BELTS: readonly (readonly [number, number, Direction])[] = [
  [1, 3, Direction.South],
  [1, 4, Direction.East],
  [2, 4, Direction.East],
  [3, 4, Direction.East],
  [2, 5, Direction.North],
];

/** Entities player 0 builds on its patch after mining it (ids follow the twelve built at the spawn). */
export const DETERMINISM_PATCH_FURNACE = 13;
export const DETERMINISM_PATCH_CHEST = 14;
export const DETERMINISM_PATCH_DRILL = 15;
export const DETERMINISM_DRILL_CHEST = 16;
/** Ticks after the drill is fuelled until the chest in front of it is placed. */
const DETERMINISM_DRILL_CHEST_DELAY = 300;

/**
 * Player 0's work on its iron patch, starting on tick `tick` while it stands
 * on `(x, y)`: a furnace two tiles east, fuelled and loaded with the mined
 * ore; a chest two tiles west; a fuelled drill two tiles south facing north,
 * which holds its first ore (nothing is in front of it) until a second chest
 * is placed on its drop tile; then, near the end of the scripted phase, the
 * plates so far go from the furnace into the chest, together with the kit
 * plates that crafting left (see craftPhase), and one comes back. The furnace
 * is the one player 0 crafts at the start of craftPhase.
 */
function smeltPhase(tick: number, x: number, y: number): Command[] {
  const p = { playerId: 0 };
  const furnace = DETERMINISM_PATCH_FURNACE;
  const chest = DETERMINISM_PATCH_CHEST;
  const drill = DETERMINISM_PATCH_DRILL;
  const end = DETERMINISM_SCRIPTED_TICKS - 10;
  return [
    { ...p, tick, type: 'Place', item: ItemId.StoneFurnace, x: x + 2, y: y - 1, dir: 0 },
    { ...p, tick: tick + 1, type: 'Insert', entity: furnace, item: ItemId.Coal, count: 3 },
    { ...p, tick: tick + 1, type: 'Insert', entity: furnace, item: ItemId.IronOre, count: 50 },
    { ...p, tick: tick + 2, type: 'Place', item: ItemId.WoodenChest, x: x - 2, y, dir: 0 },
    // Ignored: the output is still empty.
    { ...p, tick: tick + 3, type: 'Take', entity: furnace, slot: FurnaceSlot.Output, count: 5 },
    // The drill covers (x - 1..x, y + 2..y + 3) and drops onto (x - 1, y + 1).
    {
      ...p,
      tick: tick + 4,
      type: 'Place',
      item: ItemId.BurnerMiningDrill,
      x: x - 1,
      y: y + 2,
      dir: 0,
    },
    { ...p, tick: tick + 5, type: 'Insert', entity: drill, item: ItemId.Coal, count: 2 },
    {
      ...p,
      tick: tick + 5 + DETERMINISM_DRILL_CHEST_DELAY,
      type: 'Place',
      item: ItemId.WoodenChest,
      x: x - 1,
      y: y + 1,
      dir: 0,
    },
    { ...p, tick: end, type: 'Take', entity: furnace, slot: FurnaceSlot.Output, count: 100 },
    { ...p, tick: end + 1, type: 'Insert', entity: chest, item: ItemId.IronPlate, count: 100 },
    { ...p, tick: end + 2, type: 'Take', entity: chest, slot: 0, count: 1 },
  ];
}

/**
 * Hand-crafting while the players walk and mine (it only uses
 * `DETERMINISM_KIT` items, so the mined ore stays untouched).
 */
function craftPhase(): Command[] {
  const craft = (tick: number, playerId: number, recipe: number, count: number): Command => ({
    tick,
    playerId,
    type: 'Craft',
    recipe,
    count,
  });
  const cancel = (tick: number, playerId: number, index: number): Command => ({
    tick,
    playerId,
    type: 'CancelCraft',
    index,
  });
  const B = DETERMINISM_BUILD_TICKS;
  return [
    // Player 0 first crafts the furnace it will place on its patch (smeltPhase)
    // from 5 of the kit's 10 stone. It has one furnace left after building:
    // the second drill queues another furnace from the other 5 stone; both
    // queue their gears. 18 plates.
    craft(B, 0, RecipeId.StoneFurnace, 1),
    craft(B, 0, RecipeId.BurnerMiningDrill, 2),
    craft(B, 0, RecipeId.WoodenChest, 5), // only 2: 4 wood
    craft(B + 1, 0, RecipeId.TransportBelt, 1), // a gear and a plate: 21 plates
    craft(B + 1, 0, RecipeId.IronGearWheel, 5), // only 4: 8 plates left
    craft(B + 2, 0, RecipeId.StoneFurnace, 1), // ignored: the stone is reserved
    // By then the furnaces and the gears are done: the queue is drill, chest,
    // the belt's gear, belt, gears. Cancelling the gear cancels the belt too.
    cancel(B + 300, 0, 2),
    cancel(B + 301, 0, 9), // ignored: no such entry
    // Player 1 cancels its inserters while their second gear is under way.
    craft(5, 1, RecipeId.BurnerInserter, 3),
    cancel(40, 1, 0),
    craft(41, 1, RecipeId.IronGearWheel, 15), // 14: the refund brings it back to 28 plates
    // Player 2 crafts on its way to the stone patch (the kit's stone stays put).
    craft(10, 2, RecipeId.WoodenChest, 1),
    craft(10, 2, RecipeId.IronPlate, 1), // ignored: smelting, not hand
    craft(10, 2, RecipeId.BurnerInserter, 2),
  ];
}

/** Phase 1: player 0 builds, then each player walks to a starting ore patch and mines it. */
function scriptedPhase(): Command[] {
  const commands: Command[] = [...buildPhase(), ...craftPhase()];
  const patches = startingPatches(DETERMINISM_SEED);
  for (let id = 0; id < DETERMINISM_PLAYERS; id++) {
    const patch = patches[id]!;
    const start = id === 0 ? DETERMINISM_BUILD_TICKS : 5 * id;
    const w: Walker = { playerId: id, tick: start, x: 0, y: 0 };
    if (id === 2) {
      // Start mining from the spawn, far out of reach: it waits until the player arrives.
      commands.push({ tick: w.tick, playerId: id, type: 'MineStart', x: patch.x, y: patch.y });
    }
    walkTo(commands, w, tileToFixed(patch.x) + HALF_TILE, tileToFixed(patch.y) + HALF_TILE);
    commands.push({ tick: w.tick, playerId: id, type: 'MineStart', x: patch.x, y: patch.y });
    w.tick += 300;
    // The neighbouring tile is ore too: starting patches are wider than that.
    commands.push({ tick: w.tick, playerId: id, type: 'MineStart', x: patch.x, y: patch.y + 1 });
    w.tick += 150;
    if (id === 1) {
      // Walk away while still mining: mining pauses once out of reach.
      commands.push({ tick: w.tick, playerId: id, type: 'Move', dx: sign(-patch.x), dy: 0 });
      w.tick += 60;
      commands.push({ tick: w.tick, playerId: id, type: 'Move', dx: 0, dy: 0 });
    }
    commands.push({ tick: w.tick, playerId: id, type: 'MineStop' });
    if (id === 0) {
      commands.push(...smeltPhase(w.tick, fixedToTile(w.x), fixedToTile(w.y)));
    }
  }
  return commands;
}

/**
 * Builds a fixed command log covering every command type: the scripted
 * walk-and-mine phase, then pseudo-random commands for several players,
 * several commands on the same tick, and commands for player ids that don't
 * exist. Commands are returned in a shuffled (but fixed) order so the test
 * also covers the queue's sorting.
 */
export function buildDeterminismScript(
  ticks: number = DETERMINISM_TICKS,
  scriptSeed: number = DETERMINISM_SCRIPT_SEED,
): Command[] {
  const rng = Rng.fromSeed(scriptSeed);
  const limit = Math.min(ticks, DETERMINISM_SCRIPTED_TICKS);
  const commands: Command[] = scriptedPhase().filter((c) => c.tick < limit);
  for (let tick = DETERMINISM_SCRIPTED_TICKS; tick < ticks; tick++) {
    // About one command every 8 ticks, sometimes a burst on the same tick.
    if (rng.nextInt(8) !== 0) {
      continue;
    }
    const burst = 1 + rng.nextInt(3);
    for (let i = 0; i < burst; i++) {
      // Player id DETERMINISM_PLAYERS is out of range on purpose: it must be ignored.
      const playerId = rng.nextInt(DETERMINISM_PLAYERS + 1);
      const kind = rng.nextInt(18);
      if (kind < 6) {
        commands.push({
          tick,
          playerId,
          type: 'Move',
          dx: AXES[rng.nextInt(3)]!,
          dy: AXES[rng.nextInt(3)]!,
        });
      } else if (kind < 8) {
        commands.push({
          tick,
          playerId,
          type: 'MineStart',
          x: rng.nextInt(201) - 100,
          y: rng.nextInt(201) - 100,
        });
      } else if (kind < 9) {
        commands.push({ tick, playerId, type: 'MineStop' });
      } else if (kind >= 16) {
        // Crafting: any recipe id, including smelting and unknown ones; most
        // fail for lack of items, but mined stone makes furnaces.
        if (kind === 16) {
          const recipe = rng.nextInt(RECIPE_ID_SPAN);
          commands.push({ tick, playerId, type: 'Craft', recipe, count: 1 + rng.nextInt(6) });
        } else {
          commands.push({ tick, playerId, type: 'CancelCraft', index: rng.nextInt(4) });
        }
      } else if (kind >= 14) {
        // GUI transfers with any entity id (most don't exist or are out of reach).
        const entity = rng.nextInt(ENTITY_ID_SPAN);
        const count = 1 + rng.nextInt(60);
        if (kind === 14) {
          const item = rng.nextInt(ITEM_ID_SPAN);
          commands.push({ tick, playerId, type: 'Insert', entity, item, count });
        } else {
          commands.push({ tick, playerId, type: 'Take', entity, slot: rng.nextInt(18), count });
        }
      } else {
        // Build commands around the spawn and the starting patches, where the
        // players roam; most are out of reach or blocked and must be ignored.
        const x = rng.nextInt(81) - 40;
        const y = rng.nextInt(81) - 40;
        if (kind < 12) {
          // Any item id, including ones that place nothing and unknown ones.
          const item = rng.nextInt(ITEM_ID_SPAN);
          const dir = rng.nextInt(4) as Direction;
          commands.push({ tick, playerId, type: 'Place', item, x, y, dir });
        } else {
          commands.push({ tick, playerId, type: kind < 13 ? 'Remove' : 'Rotate', x, y });
        }
      }
    }
  }
  // Fixed Fisher-Yates shuffle: enqueue order across ticks/players must not matter.
  // Commands of the same player on the same tick keep their relative order.
  const shuffled = commands.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return stableSamePlayerOrder(shuffled, commands);
}

/**
 * Restores the original relative order of commands that share a tick and a
 * player (that order is meaningful), keeping the shuffled order otherwise.
 */
function stableSamePlayerOrder(shuffled: Command[], original: Command[]): Command[] {
  const key = (c: Command): string => `${String(c.tick)}:${String(c.playerId)}`;
  const queues = new Map<string, Command[]>();
  for (const c of original) {
    const k = key(c);
    const q = queues.get(k);
    if (q) {
      q.push(c);
    } else {
      queues.set(k, [c]);
    }
  }
  return shuffled.map((c) => queues.get(key(c))!.shift()!);
}

export interface DeterminismResult {
  hash: number;
  tick: number;
  commands: number;
  /** Units of items the players hold at the end, including the starting kits. */
  itemsMined: number;
  /** Entities on the map at the end (proof that building happened). */
  entities: number;
}

/** A fresh simulation set up like the scenario's (seed, players, kit), before any command. */
export function createDeterminismSim(): Sim {
  return new Sim({
    seed: DETERMINISM_SEED,
    players: DETERMINISM_PLAYERS,
    startingKit: DETERMINISM_KIT,
  });
}

/** Runs the scenario from scratch and returns the final state hash. */
export function runDeterminismScenario(ticks: number = DETERMINISM_TICKS): DeterminismResult {
  const sim = createDeterminismSim();
  const script = buildDeterminismScript(ticks);
  for (const cmd of script) {
    sim.enqueue(cmd);
  }
  for (let i = 0; i < ticks; i++) {
    sim.step();
  }
  let itemsMined = 0;
  for (const count of sim.state.players.invCounts) {
    itemsMined += count;
  }
  return {
    hash: sim.hash(),
    tick: sim.tick,
    commands: script.length,
    itemsMined,
    entities: sim.state.entities.count,
  };
}
