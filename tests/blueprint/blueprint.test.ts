/**
 * Blueprints: capture, rotation and pasting (D59). The capture reads the
 * same snapshot records the renderer gets (entities and belts), and a paste
 * runs its planned `Place` / `Rotate` / `SetRecipe` commands through a real
 * simulation, so these tests check what a player would see in the game.
 */

import { describe, expect, it } from 'vitest';
import {
  captureBlueprint,
  normalize,
  planPaste,
  rotateBlueprint,
  rotateBlueprintBy,
  type Blueprint,
  type PendingRecipe,
  type TileBox,
} from '../../src/blueprint/blueprint';
import { ENTITIES, EntityTypeId, entityPrototype } from '../../src/data/entities';
import { ItemId, type ItemStack } from '../../src/data/items';
import { RecipeId } from '../../src/data/recipes';
import { EntityIndex } from '../../src/render/entityIndex';
import {
  UndergroundMode,
  findPartner,
  type UndergroundInfo,
} from '../../src/sim/belts/underground';
import type { CommandInput } from '../../src/sim/commands';
import { simPlacementView } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { Placement, checkPlacement } from '../../src/sim/entities/placement';
import { decodeBelts, encodeBelts, encodeEntities } from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';

const { North, East, South, West } = Direction;
/** Every chunk around the spawn the tests build in. */
const RANGE = { cx0: -2, cy0: -2, cx1: 1, cy1: 1 };

const KIT: ItemStack[] = [
  { item: ItemId.AssemblingMachine1, count: 4 },
  { item: ItemId.BurnerInserter, count: 8 },
  { item: ItemId.WoodenChest, count: 8 },
  { item: ItemId.Splitter, count: 4 },
  { item: ItemId.UndergroundBelt, count: 12 },
  { item: ItemId.Boiler, count: 4 },
  { item: ItemId.TransportBelt, count: 20 },
];

/** A game on seed 1 whose player (at the spawn) carries `kit`, with what the renderer would know of it. */
function game(kit: readonly ItemStack[] = KIT) {
  const sim = new Sim({ seed: 1, startingKit: kit });
  const send = (commands: readonly CommandInput[]) => {
    for (const c of commands) sim.enqueue({ ...c, tick: sim.tick });
    sim.step();
  };
  /** The renderer's copy of the entities and belts, from snapshot records. */
  const view = () => {
    const index = new EntityIndex();
    index.apply(encodeEntities(sim.state, RANGE).buffer);
    const unders = new Map<string, UndergroundInfo>();
    for (const b of decodeBelts(encodeBelts(sim.state, RANGE).buffer)) {
      if (b.mode === UndergroundMode.Entrance || b.mode === UndergroundMode.Exit) {
        const speed = entityPrototype(b.type)!.beltSpeed!;
        unders.set(`${String(b.x)},${String(b.y)}`, {
          speed,
          dir: b.dir as Direction,
          mode: b.mode,
        });
      }
    }
    return {
      index,
      undergroundAt: (x: number, y: number) => unders.get(`${String(x)},${String(y)}`) ?? null,
    };
  };
  const capture = (box: TileBox) => {
    const v = view();
    return captureBlueprint(v.index.entities, box, (x, y) => v.undergroundAt(x, y)?.mode ?? 0);
  };
  const count = (item: number) => sim.state.players.inventory(0).count(item);
  /** Pastes `bp` at `(ox, oy)` the way the blueprint input does, recipes included. */
  const paste = (bp: Blueprint, ox: number, oy: number) => {
    const v = view();
    const { players } = sim.state;
    const plan = planPaste(
      bp,
      ox,
      oy,
      {
        canPlace: (proto, x, y, dir) =>
          checkPlacement(
            simPlacementView(sim.state),
            proto,
            x,
            y,
            dir,
            players.x[0]!,
            players.y[0]!,
          ) === Placement.Ok,
        count,
        undergroundAt: v.undergroundAt,
      },
      0,
    );
    send(plan.commands);
    setRecipes(plan.recipes);
    return plan;
  };
  /** Sets pasted machines' recipes once they exist, as main.ts does from the next snapshot. */
  const setRecipes = (recipes: readonly PendingRecipe[]) => {
    const index = view().index;
    const commands: CommandInput[] = recipes.map((r) => ({
      type: 'SetRecipe',
      playerId: 0,
      entity: index.at(r.x, r.y)!.id,
      recipe: r.recipe,
    }));
    send(commands);
  };
  const place = (item: number, x: number, y: number, dir: Direction = North) => {
    send([{ type: 'Place', playerId: 0, item, x, y, dir }]);
    expect(
      sim.state.entities.at(x, y),
      `placed ${String(item)} at ${String(x)},${String(y)}`,
    ).not.toBe(0);
  };
  return { sim, send, view, capture, paste, place, count };
}

/** The entities of a blueprint as plain data, for comparisons. */
const plain = (bp: Blueprint | null) =>
  bp?.entities.map((e) => ({
    name: e.proto.name,
    x: e.x,
    y: e.y,
    dir: e.dir,
    recipe: e.recipe,
    mode: e.mode,
  }));

/**
 * A small factory west of the spawn, origin `(-9, -6)`, 7 × 5 tiles: an
 * assembling machine making gears fed by an inserter from a chest, a
 * boiler (2 × 3, rotatable), an underground pair, a splitter and a belt.
 */
function buildFactory(g: ReturnType<typeof game>) {
  const ox = -9;
  const oy = -6;
  g.place(ItemId.AssemblingMachine1, ox, oy);
  const am = g.sim.state.entities.at(ox, oy);
  g.send([{ type: 'SetRecipe', playerId: 0, entity: am, recipe: RecipeId.IronGearWheel }]);
  g.place(ItemId.BurnerInserter, ox + 3, oy + 1, West);
  g.place(ItemId.WoodenChest, ox + 4, oy + 1);
  g.place(ItemId.Boiler, ox + 5, oy, North);
  g.place(ItemId.UndergroundBelt, ox, oy + 3, East);
  g.place(ItemId.UndergroundBelt, ox + 2, oy + 3, East);
  g.place(ItemId.Splitter, ox + 4, oy + 3, East);
  g.place(ItemId.TransportBelt, ox + 3, oy + 4, South);
  return { x0: ox, y0: oy, x1: ox + 6, y1: oy + 4 };
}

describe('capturing a blueprint', () => {
  it('copies type, relative position, direction, recipe and underground mode, not contents', () => {
    const g = game();
    const box = buildFactory(g);
    const bp = g.capture(box)!;
    expect(bp.width).toBe(7);
    expect(bp.height).toBe(5);
    expect(plain(bp)).toEqual([
      {
        name: 'assembling-machine-1',
        x: 0,
        y: 0,
        dir: North,
        recipe: RecipeId.IronGearWheel,
        mode: 0,
      },
      { name: 'boiler', x: 5, y: 0, dir: North, recipe: 0, mode: 0 },
      { name: 'burner-inserter', x: 3, y: 1, dir: West, recipe: 0, mode: 0 },
      { name: 'wooden-chest', x: 4, y: 1, dir: North, recipe: 0, mode: 0 },
      {
        name: 'underground-belt',
        x: 0,
        y: 3,
        dir: East,
        recipe: 0,
        mode: UndergroundMode.Entrance,
      },
      { name: 'underground-belt', x: 2, y: 3, dir: East, recipe: 0, mode: UndergroundMode.Exit },
      { name: 'splitter', x: 4, y: 3, dir: East, recipe: 0, mode: 0 },
      { name: 'transport-belt', x: 3, y: 4, dir: South, recipe: 0, mode: 0 },
    ]);
  });

  it('takes every entity the box touches, and nothing from an empty box', () => {
    const g = game();
    buildFactory(g);
    // One tile of the assembling machine is enough.
    expect(plain(g.capture({ x0: -7, y0: -4, x1: -7, y1: -4 }))).toEqual([
      {
        name: 'assembling-machine-1',
        x: 0,
        y: 0,
        dir: North,
        recipe: RecipeId.IronGearWheel,
        mode: 0,
      },
    ]);
    expect(g.capture({ x0: 3, y0: 3, x1: 5, y1: 5 })).toBeNull();
  });
});

describe('rotating a blueprint', () => {
  const g = game();
  const bp = g.capture(buildFactory(g))!;

  it('turns positions and directions clockwise, swapping width and height', () => {
    const r = rotateBlueprint(bp);
    expect([r.width, r.height]).toEqual([5, 7]);
    const byName = (name: string) => plain(r)!.filter((e) => e.name === name);
    // The 3 × 3 machine at the top-left ends up at the top-right; it doesn't turn.
    expect(byName('assembling-machine-1')).toEqual([
      {
        name: 'assembling-machine-1',
        x: 2,
        y: 0,
        dir: North,
        recipe: RecipeId.IronGearWheel,
        mode: 0,
      },
    ]);
    // The 2 × 3 boiler turns to 3 × 2 and faces east.
    expect(byName('boiler')).toEqual([
      { name: 'boiler', x: 2, y: 5, dir: East, recipe: 0, mode: 0 },
    ]);
    // The splitter (2 × 1 across its direction) turns from east to south.
    expect(byName('splitter')).toEqual([
      { name: 'splitter', x: 0, y: 4, dir: South, recipe: 0, mode: 0 },
    ]);
    // The pair keeps its modes, now running south.
    expect(byName('underground-belt')).toEqual([
      {
        name: 'underground-belt',
        x: 1,
        y: 0,
        dir: South,
        recipe: 0,
        mode: UndergroundMode.Entrance,
      },
      { name: 'underground-belt', x: 1, y: 2, dir: South, recipe: 0, mode: UndergroundMode.Exit },
    ]);
  });

  it('comes back to the start after four turns, through every direction', () => {
    const seen = new Set<number>();
    let r = bp;
    for (let k = 0; k < 4; k++) {
      seen.add(r.entities.find((e) => e.proto.name === 'boiler')!.dir);
      r = rotateBlueprint(r);
    }
    expect(seen).toEqual(new Set([North, East, South, West]));
    expect(plain(r)).toEqual(plain(bp));
    expect(plain(rotateBlueprintBy(bp, -1))).toEqual(plain(rotateBlueprintBy(bp, 3)));
  });
});

describe('pasting a blueprint', () => {
  // Every turn, pasted east of the spawn into a game of its own: the pasted
  // entities, copied again, must be the turned blueprint, with the recipe
  // set, the boiler and splitter on the turned footprints and the
  // underground pair still a pair.
  for (const turns of [0, 1, 2, 3]) {
    it(`builds the blueprint turned ${String(turns * 90)}° with the same orientation and pairing`, () => {
      const g = game();
      const bp = g.capture(buildFactory(g))!;
      const turned = rotateBlueprintBy(bp, turns);
      const ox = 2;
      const oy = -3;
      const plan = g.paste(turned, ox, oy);
      expect(plan.placed).toBe(bp.entities.length);
      expect(plan.blocked).toBe(0);
      expect(plan.missing.size).toBe(0);
      const box = { x0: ox, y0: oy, x1: ox + turned.width - 1, y1: oy + turned.height - 1 };
      const again = g.capture(box)!;
      expect(plain(again)).toEqual(plain(turned));
      // The pair is paired in the simulation's eyes too (the renderer's copy says so).
      const v = g.view();
      const unders = again.entities.filter((e) => e.mode !== UndergroundMode.None);
      const entrance = unders.find((e) => e.mode === UndergroundMode.Entrance)!;
      const exit = unders.find((e) => e.mode === UndergroundMode.Exit)!;
      const partner = findPartner(
        v.undergroundAt,
        ox + entrance.x,
        oy + entrance.y,
        entrance.dir,
        UndergroundMode.Entrance,
        entrance.proto.beltSpeed!,
        entrance.proto.undergroundMaxGap!,
      );
      expect(partner).toMatchObject({ x: ox + exit.x, y: oy + exit.y });
    });
  }

  it('keeps an exit an exit when its entrance isn’t in the blueprint', () => {
    const g = game();
    g.place(ItemId.UndergroundBelt, -8, -4, East);
    g.place(ItemId.UndergroundBelt, -5, -4, East);
    // Only the exit, and a chain of a second pair behind it.
    g.place(ItemId.UndergroundBelt, -4, -4, East);
    g.place(ItemId.UndergroundBelt, -2, -4, East);
    const bp = g.capture({ x0: -5, y0: -4, x1: -2, y1: -4 })!;
    expect(plain(bp)!.map((e) => e.mode)).toEqual([
      UndergroundMode.Exit,
      UndergroundMode.Entrance,
      UndergroundMode.Exit,
    ]);
    for (const turns of [0, 1, 2, 3]) {
      const t = game();
      const turned = rotateBlueprintBy(bp, turns);
      const plan = t.paste(turned, 2, 2);
      expect(plan.placed).toBe(3);
      const again = t.capture({
        x0: 2,
        y0: 2,
        x1: 2 + turned.width - 1,
        y1: 2 + turned.height - 1,
      });
      expect(plain(again)).toEqual(plain(turned));
    }
  });

  it('places what the inventory affords and skips the rest, saying what is missing', () => {
    const kit = [
      { item: ItemId.WoodenChest, count: 2 },
      { item: ItemId.TransportBelt, count: 1 },
    ];
    const g = game(kit);
    const chest = ENTITIES[EntityTypeId.WoodenChest];
    const belt = ENTITIES[EntityTypeId.TransportBelt];
    const bp = normalize('row', [
      { proto: chest, x: 0, y: 0, dir: North, recipe: 0, mode: 0 },
      { proto: chest, x: 1, y: 0, dir: North, recipe: 0, mode: 0 },
      { proto: chest, x: 2, y: 0, dir: North, recipe: 0, mode: 0 },
      { proto: belt, x: 3, y: 0, dir: East, recipe: 0, mode: 0 },
      { proto: belt, x: 4, y: 0, dir: East, recipe: 0, mode: 0 },
    ])!;
    const plan = g.paste(bp, 2, 2);
    expect(plan.placed).toBe(3);
    expect([...plan.missing]).toEqual([
      [ItemId.WoodenChest, 1],
      [ItemId.TransportBelt, 1],
    ]);
    expect(plan.entities.map((e) => e.skip)).toEqual([null, null, 'missing', null, 'missing']);
    expect(g.count(ItemId.WoodenChest)).toBe(0);
    expect(g.count(ItemId.TransportBelt)).toBe(0);
    // Pasting again over it: everything is in the way now.
    const again = g.paste(bp, 2, 2);
    expect(again.placed).toBe(0);
    expect(again.commands).toEqual([]);
    expect(again.blocked).toBe(3);
  });

  it('skips what is out of reach', () => {
    const g = game();
    const chest = ENTITIES[EntityTypeId.WoodenChest];
    const bp = normalize('far', [
      { proto: chest, x: 0, y: 0, dir: North, recipe: 0, mode: 0 },
      { proto: chest, x: 12, y: 0, dir: North, recipe: 0, mode: 0 },
    ])!;
    const plan = g.paste(bp, 2, 2);
    expect(plan.placed).toBe(1);
    expect(plan.blocked).toBe(1);
  });
});
