import { describe, expect, it } from 'vitest';
import {
  ENTITIES,
  ENTITY_TYPE_IDS,
  EntityTypeId,
  MAX_ENTITY_SIZE,
  entityForItem,
  entityPrototype,
} from '../../src/data/entities';
import { ITEMS, ItemId, itemPrototype, type ItemStack } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';
import { TileId } from '../../src/data/tiles';
import { BuildResult, placeEntity, removeEntity, rotateEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { Entities } from '../../src/sim/entities/entities';
import { MachineState } from '../../src/sim/entities/machine';
import { Occupancy } from '../../src/sim/entities/occupancy';
import { BUILD_REACH, inBuildReach } from '../../src/sim/entities/placement';
import { SparseSet } from '../../src/sim/entities/sparseSet';
import type { EntityTypeTable } from '../../src/sim/entities/table';
import { WakeSubscriptions } from '../../src/sim/entities/wake';
import { tileCenter } from '../../src/sim/fixed';
import { PLAYER_INVENTORY_SLOTS } from '../../src/sim/inventory';
import { ENTITY_STRIDE, EntityField, encodeEntities } from '../../src/sim/snapshot';
import type { SimState } from '../../src/sim/state';
import { Sim } from '../../src/sim/tick';

const { North, East, South, West } = Direction;

/** A sim whose player 0 stands at the center of tile `(tx, ty)`. */
function simAt(tx: number, ty: number, players = 1): Sim {
  const sim = new Sim({ seed: 1, players });
  sim.state.players.x[0] = tileCenter(tx);
  sim.state.players.y[0] = tileCenter(ty);
  return sim;
}

const place = (state: SimState, item: number, x: number, y: number, dir: number = North) =>
  placeEntity(state, 0, item, x, y, dir);

/** Entity ids covering each tile of the rectangle, row by row. */
function covering(state: SimState, x: number, y: number, w: number, h: number): number[] {
  const out: number[] = [];
  for (let ty = y; ty < y + h; ty++) {
    for (let tx = x; tx < x + w; tx++) out.push(state.entities.at(tx, ty));
  }
  return out;
}

/** A water tile with a buildable tile to its left, within 200 tiles of the origin. */
function findWater(sim: Sim): { x: number; y: number } {
  const { world } = sim.state;
  for (let y = -200; y < 200; y++) {
    for (let x = -200; x < 200; x++) {
      if (world.tileAt(x, y) === TileId.Water && world.tileAt(x - 1, y) !== TileId.Water) {
        return { x, y };
      }
    }
  }
  throw new Error('no water found');
}

describe('entity prototypes', () => {
  it('are keyed by their own id, fit the size limit, and each has its own placing item', () => {
    expect(ENTITY_TYPE_IDS).toEqual(
      Object.keys(ENTITIES)
        .map(Number)
        .sort((a, b) => a - b),
    );
    const items = new Set<number>();
    for (const id of ENTITY_TYPE_IDS) {
      const proto = ENTITIES[id];
      expect(proto.id).toBe(id);
      expect(proto.width).toBeGreaterThanOrEqual(1);
      expect(proto.height).toBeGreaterThanOrEqual(1);
      expect(Math.max(proto.width, proto.height)).toBeLessThanOrEqual(MAX_ENTITY_SIZE);
      expect(itemPrototype(proto.item)?.name).toBe(proto.name);
      expect(entityForItem(proto.item)).toBe(proto);
      items.add(proto.item);
    }
    expect(items.size).toBe(ENTITY_TYPE_IDS.length);
    expect(entityPrototype(EntityTypeId.None)).toBeUndefined();
    expect(entityForItem(ItemId.IronOre)).toBeUndefined();
  });

  it('include the M1 placeholders with their footprints', () => {
    const size = (id: keyof typeof ENTITIES) => [ENTITIES[id].width, ENTITIES[id].height];
    expect(size(EntityTypeId.WoodenChest)).toEqual([1, 1]);
    expect(size(EntityTypeId.StoneFurnace)).toEqual([2, 2]);
    expect(size(EntityTypeId.BurnerMiningDrill)).toEqual([2, 2]);
    expect(size(EntityTypeId.TransportBelt)).toEqual([1, 1]);
    expect(size(EntityTypeId.BurnerInserter)).toEqual([1, 1]);
    expect(ENTITIES[EntityTypeId.TransportBelt].rotatable).toBe(true);
    expect(ENTITIES[EntityTypeId.BurnerInserter].rotatable).toBe(true);
    expect(ENTITIES[EntityTypeId.WoodenChest].rotatable).toBe(false);
  });
});

describe('starting kit', () => {
  it('gives every player the M1 kit in hotbar order', () => {
    const sim = new Sim({ seed: 1, players: 2 });
    for (const id of [0, 1]) {
      const inv = sim.state.players.inventory(id);
      STARTING_KIT.forEach((stack, slot) => {
        expect([inv.items[slot], inv.counts[slot]]).toEqual([stack.item, stack.count]);
      });
    }
    const count = (item: number) => STARTING_KIT.find((s) => s.item === item)?.count;
    expect(count(ItemId.TransportBelt)).toBe(10);
    expect(count(ItemId.BurnerMiningDrill)).toBe(2);
    expect(count(ItemId.StoneFurnace)).toBe(2);
    expect(count(ItemId.WoodenChest)).toBe(2);
    expect(count(ItemId.BurnerInserter)).toBe(4);
    expect(count(ItemId.Coal)).toBe(10);
    expect(
      new Sim({ seed: 1, startingKit: [] }).state.players.inventory(0).count(ItemId.Coal),
    ).toBe(0);
  });
});

describe('SparseSet', () => {
  it('adds, looks up, and swap-removes', () => {
    const set = new SparseSet();
    expect([set.add(7), set.add(3), set.add(100)]).toEqual([0, 1, 2]);
    expect(Array.from(set.dense)).toEqual([7, 3, 100]);
    expect(set.indexOf(100)).toBe(2);
    expect(set.indexOf(4)).toBe(-1);
    expect(set.indexOf(1_000_000)).toBe(-1);
    // Removing 7 moves the last member (100) into its slot.
    expect(set.remove(7)).toBe(0);
    expect(Array.from(set.dense)).toEqual([100, 3]);
    expect(set.indexOf(100)).toBe(0);
    expect(set.has(7)).toBe(false);
    expect(set.remove(7)).toBe(-1);
    // Removing the last member moves nothing.
    expect(set.remove(3)).toBe(1);
    expect(Array.from(set.dense)).toEqual([100]);
    expect(() => set.add(100)).toThrow(RangeError);
    expect(() => set.add(0)).toThrow(RangeError);
  });
});

describe('Occupancy', () => {
  it('covers footprints across chunk borders and at negative coordinates', () => {
    const occ = new Occupancy();
    // A 2×2 footprint on the corner where four chunks meet: tiles -1..0 × -1..0.
    occ.fill(5, -1, -1, 2, 2);
    expect([occ.at(-1, -1), occ.at(0, -1), occ.at(-1, 0), occ.at(0, 0)]).toEqual([5, 5, 5, 5]);
    expect([occ.at(1, 0), occ.at(-2, -1), occ.at(0, 1)]).toEqual([0, 0, 0]);
    expect(occ.chunkCount).toBe(4);
    // The origin chunk is the one of the top-left tile.
    expect(occ.originsIn({ cx0: -1, cy0: -1, cx1: -1, cy1: -1 })).toEqual([5]);
    expect(occ.originsIn({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 })).toEqual([]);
    expect(() => occ.fill(6, 0, 0, 1, 1)).toThrow(RangeError);
    occ.clear(5, -1, -1, 2, 2);
    expect(occ.at(0, 0)).toBe(0);
    expect(occ.chunkCount).toBe(0);
    // Out-of-range tiles are simply free.
    expect(occ.at(2 ** 31 - 1, 0)).toBe(0);
  });

  it('hashes the covered tiles independently of insertion order', () => {
    const a = new Occupancy();
    const b = new Occupancy();
    a.fill(1, 40, 3, 1, 1);
    a.fill(2, -70, 3, 2, 2);
    b.fill(2, -70, 3, 2, 2);
    b.fill(1, 40, 3, 1, 1);
    expect(a.hashInto()).toBe(b.hashInto());
    b.clear(1, 40, 3, 1, 1);
    expect(a.hashInto()).not.toBe(b.hashInto());
  });
});

describe('WakeSubscriptions', () => {
  it('tracks watchers per target and drops them by watcher or target', () => {
    const wake = new WakeSubscriptions();
    wake.watch(10, 1);
    wake.watch(11, 1);
    wake.watch(10, 2);
    wake.watch(10, 2);
    expect(wake.size).toBe(3);
    expect(wake.watchersOf(1)).toEqual([10, 11]);
    const h = wake.hashInto();
    wake.unwatchAll(10);
    expect(wake.watchersOf(1)).toEqual([11]);
    expect(wake.watchersOf(2)).toEqual([]);
    expect(wake.hashInto()).not.toBe(h);
    expect(wake.forgetTarget(1)).toEqual([11]);
    expect(wake.size).toBe(0);
  });
});

describe('build reach', () => {
  it('compares the squared distance to the footprint center with 10 tiles', () => {
    expect(BUILD_REACH).toBe(2560);
    const [px, py] = [tileCenter(0), tileCenter(0)];
    expect(inBuildReach(px, py, 10, 0, 1, 1)).toBe(true);
    expect(inBuildReach(px, py, 11, 0, 1, 1)).toBe(false);
    expect(inBuildReach(px, py, 7, 7, 1, 1)).toBe(true);
    expect(inBuildReach(px, py, 8, 7, 1, 1)).toBe(false);
    // A 2×2 footprint's center is its middle corner: (10..11) has its center 10.5 tiles out.
    expect(inBuildReach(px, py, 9, 0, 2, 2)).toBe(true);
    expect(inBuildReach(px, py, 10, -1, 2, 2)).toBe(false);
    // Exactly on the boundary counts, one subtile further doesn't.
    expect(inBuildReach(tileCenter(0) - BUILD_REACH, py, 0, 0, 1, 1)).toBe(true);
    expect(inBuildReach(tileCenter(0) - BUILD_REACH - 1, py, 0, 0, 1, 1)).toBe(false);
    expect(inBuildReach(px, py, 0x7fff_ffff, -0x8000_0000, 2, 2)).toBe(false);
  });
});

describe('Place', () => {
  it('places an entity and takes its item from the inventory', () => {
    const sim = simAt(0, 0);
    const { state } = sim;
    const inv = state.players.inventory(0);
    expect(place(state, ItemId.WoodenChest, 2, 0)).toBe(BuildResult.Ok);
    expect(inv.count(ItemId.WoodenChest)).toBe(1);
    const id = state.entities.at(2, 0);
    expect(id).toBe(1);
    expect(state.entities.store.type(id)).toBe(EntityTypeId.WoodenChest);
    expect(state.entities.footprint(id)).toEqual({ x: 2, y: 0, w: 1, h: 1 });
    // Ids are never reused.
    expect(removeEntity(state, 0, 2, 0)).toBe(BuildResult.Ok);
    expect(place(state, ItemId.WoodenChest, 2, 0)).toBe(BuildResult.Ok);
    expect(state.entities.at(2, 0)).toBe(2);
    expect(state.entities.store.nextId).toBe(3);
  });

  it('refuses overlapping footprints, including 2×2 ones', () => {
    const { state } = simAt(0, 0);
    expect(place(state, ItemId.StoneFurnace, 3, 0)).toBe(BuildResult.Ok);
    expect(covering(state, 3, 0, 2, 2)).toEqual([1, 1, 1, 1]);
    for (const [x, y] of [
      [4, 1],
      [2, -1],
      [4, -1],
      [2, 1],
    ]) {
      expect(place(state, ItemId.BurnerMiningDrill, x!, y!)).toBe(BuildResult.Blocked);
    }
    expect(place(state, ItemId.TransportBelt, 4, 1)).toBe(BuildResult.Blocked);
    expect(place(state, ItemId.BurnerMiningDrill, 5, 0)).toBe(BuildResult.Ok);
    expect(place(state, ItemId.BurnerMiningDrill, 1, 0)).toBe(BuildResult.Ok);
    expect(state.entities.count).toBe(3);
    // Nothing was taken for the refused placements.
    expect(state.players.inventory(0).count(ItemId.TransportBelt)).toBe(10);
    expect(state.players.inventory(0).count(ItemId.BurnerMiningDrill)).toBe(0);
  });

  it('refuses water', () => {
    const sim = new Sim({ seed: 1 });
    const water = findWater(sim);
    sim.state.players.x[0] = tileCenter(water.x - 3);
    sim.state.players.y[0] = tileCenter(water.y);
    expect(place(sim.state, ItemId.WoodenChest, water.x, water.y)).toBe(BuildResult.Blocked);
    // A 2×2 footprint with only one tile in the water is refused too.
    expect(place(sim.state, ItemId.StoneFurnace, water.x - 1, water.y - 1)).toBe(
      BuildResult.Blocked,
    );
    expect(sim.state.entities.count).toBe(0);
    expect(place(sim.state, ItemId.WoodenChest, water.x - 1, water.y)).toBe(BuildResult.Ok);
  });

  it('refuses footprints out of reach', () => {
    const { state } = simAt(0, 0);
    expect(place(state, ItemId.WoodenChest, 11, 0)).toBe(BuildResult.Blocked);
    expect(place(state, ItemId.WoodenChest, 0, -11)).toBe(BuildResult.Blocked);
    expect(place(state, ItemId.WoodenChest, 10, 0)).toBe(BuildResult.Ok);
    expect(place(state, ItemId.WoodenChest, 0, -10)).toBe(BuildResult.Ok);
  });

  it("refuses tiles under any player's collision box", () => {
    const sim = simAt(0, 0, 2);
    const p = sim.state.players;
    // Player 0 stands in the middle of tile (0, 0): its 0.4-tile box stays inside it.
    expect(place(sim.state, ItemId.WoodenChest, 0, 0)).toBe(BuildResult.Blocked);
    expect(place(sim.state, ItemId.WoodenChest, 1, 0)).toBe(BuildResult.Ok);
    // Player 1 stands on the corner of four tiles, so its box touches all four.
    p.x[1] = tileCenter(4) + 128;
    p.y[1] = tileCenter(4) + 128;
    for (const [x, y] of [
      [4, 4],
      [5, 4],
      [4, 5],
      [5, 5],
    ]) {
      expect(placeEntity(sim.state, 0, ItemId.TransportBelt, x!, y!, North)).toBe(
        BuildResult.Blocked,
      );
    }
    expect(place(sim.state, ItemId.StoneFurnace, 3, 3)).toBe(BuildResult.Blocked);
    expect(place(sim.state, ItemId.StoneFurnace, 2, 2)).toBe(BuildResult.Ok);
  });

  it('places 2×2 footprints across chunk borders and at negative coordinates', () => {
    for (const [tx, ty] of [
      [31, 31],
      [-1, -1],
      [-33, 31],
      [-1, -33],
    ]) {
      const { state } = simAt(tx! + 3, ty! + 3);
      expect(place(state, ItemId.StoneFurnace, tx!, ty!)).toBe(BuildResult.Ok);
      const id = state.entities.at(tx!, ty!);
      expect(covering(state, tx!, ty!, 2, 2)).toEqual([id, id, id, id]);
      expect(covering(state, tx! - 1, ty!, 1, 2)).toEqual([0, 0]);
      expect(covering(state, tx! + 2, ty!, 1, 2)).toEqual([0, 0]);
      // Its neighbours across the border still fit, the overlapping placements don't.
      expect(place(state, ItemId.BurnerMiningDrill, tx! + 2, ty!)).toBe(BuildResult.Ok);
      expect(place(state, ItemId.BurnerMiningDrill, tx! + 1, ty! + 1)).toBe(BuildResult.Blocked);
      expect(removeEntity(state, 0, tx! + 1, ty! + 1)).toBe(BuildResult.Ok);
      expect(covering(state, tx!, ty!, 2, 2)).toEqual([0, 0, 0, 0]);
    }
  });

  it('needs the item, and an item that places something', () => {
    const { state } = simAt(0, 0);
    expect(place(state, ItemId.IronOre, 2, 0)).toBe(BuildResult.NotPlaceable);
    expect(place(state, 999, 2, 0)).toBe(BuildResult.NotPlaceable);
    expect(place(state, ItemId.WoodenChest, 2, 0, 4)).toBe(BuildResult.NotPlaceable);
    expect(place(state, ItemId.WoodenChest, 2, 0)).toBe(BuildResult.Ok);
    expect(place(state, ItemId.WoodenChest, 3, 0)).toBe(BuildResult.Ok);
    expect(place(state, ItemId.WoodenChest, 4, 0)).toBe(BuildResult.NoItem);
    expect(state.entities.count).toBe(2);
  });

  it('keeps the direction of rotatable entities and drops it for the others', () => {
    const { state } = simAt(0, 0);
    expect(place(state, ItemId.TransportBelt, 2, 0, West)).toBe(BuildResult.Ok);
    expect(place(state, ItemId.WoodenChest, 3, 0, East)).toBe(BuildResult.Ok);
    expect(state.entities.store.dir(state.entities.at(2, 0))).toBe(West);
    expect(state.entities.store.dir(state.entities.at(3, 0))).toBe(North);
  });
});

describe('Remove', () => {
  it('refunds the item', () => {
    const { state } = simAt(0, 0);
    const inv = state.players.inventory(0);
    place(state, ItemId.StoneFurnace, 2, 2);
    expect(inv.count(ItemId.StoneFurnace)).toBe(1);
    // Any tile of the footprint selects it.
    expect(removeEntity(state, 0, 3, 3)).toBe(BuildResult.Ok);
    expect(inv.count(ItemId.StoneFurnace)).toBe(2);
    expect(state.entities.count).toBe(0);
    expect(covering(state, 2, 2, 2, 2)).toEqual([0, 0, 0, 0]);
    expect(removeEntity(state, 0, 3, 3)).toBe(BuildResult.NoEntity);
  });

  it('fails without changing anything when the refund does not fit', () => {
    const { state } = simAt(0, 0);
    const inv = state.players.inventory(0);
    place(state, ItemId.WoodenChest, 2, 0);
    place(state, ItemId.WoodenChest, 3, 0);
    // Fill every empty slot with stone: no room for a chest any more.
    inv.add(ItemId.Stone, inv.spaceFor(ItemId.Stone));
    expect(inv.spaceFor(ItemId.WoodenChest)).toBe(0);
    expect(removeEntity(state, 0, 2, 0)).toBe(BuildResult.InventoryFull);
    expect(state.entities.count).toBe(2);
    expect(inv.count(ItemId.WoodenChest)).toBe(0);
    // Free one slot: now it fits.
    inv.remove(ItemId.Stone, ITEMS[ItemId.Stone].stackSize);
    expect(removeEntity(state, 0, 2, 0)).toBe(BuildResult.Ok);
    expect(inv.count(ItemId.WoodenChest)).toBe(1);
  });

  it('needs reach', () => {
    const sim = simAt(0, 0);
    place(sim.state, ItemId.WoodenChest, 10, 0);
    sim.state.players.x[0] = tileCenter(-1);
    expect(removeEntity(sim.state, 0, 10, 0)).toBe(BuildResult.OutOfReach);
    expect(sim.state.entities.count).toBe(1);
  });
});

describe('Rotate', () => {
  it('turns rotatable entities clockwise and ignores the others', () => {
    const { state } = simAt(0, 0);
    place(state, ItemId.TransportBelt, 2, 0, North);
    place(state, ItemId.StoneFurnace, 3, 0);
    const belt = state.entities.at(2, 0);
    const dirs: number[] = [];
    for (let i = 0; i < 4; i++) {
      expect(rotateEntity(state, 0, 2, 0)).toBe(BuildResult.Ok);
      dirs.push(state.entities.store.dir(belt));
    }
    expect(dirs).toEqual([East, South, West, North]);
    expect(rotateEntity(state, 0, 4, 1)).toBe(BuildResult.NotRotatable);
    expect(rotateEntity(state, 0, 9, 9)).toBe(BuildResult.NoEntity);
    // A 2×2 drill turns in place.
    place(state, ItemId.BurnerMiningDrill, -3, 0, North);
    expect(rotateEntity(state, 0, -2, 1)).toBe(BuildResult.Ok);
    expect(state.entities.footprint(state.entities.at(-3, 0))).toEqual({ x: -3, y: 0, w: 2, h: 2 });
  });
});

describe('build commands through the Sim', () => {
  const cmd = { tick: 0, playerId: 0 } as const;

  it('apply on their tick', () => {
    const sim = simAt(0, 0);
    sim.enqueue({ ...cmd, type: 'Place', item: ItemId.TransportBelt, x: 2, y: 0, dir: East });
    sim.enqueue({ ...cmd, tick: 1, type: 'Rotate', x: 2, y: 0 });
    sim.step();
    const { entities } = sim.state;
    expect(entities.store.dir(entities.at(2, 0))).toBe(East);
    sim.step();
    expect(entities.store.dir(entities.at(2, 0))).toBe(South);
    sim.enqueue({ ...cmd, tick: 2, type: 'Remove', x: 2, y: 0 });
    sim.step();
    expect(entities.count).toBe(0);
    expect(sim.state.players.inventory(0).count(ItemId.TransportBelt)).toBe(10);
  });

  it('change the hash when they apply', () => {
    const a = simAt(0, 0);
    const b = simAt(0, 0);
    b.enqueue({ ...cmd, type: 'Place', item: ItemId.WoodenChest, x: 2, y: 0, dir: North });
    a.step();
    b.step();
    expect(b.hash()).not.toBe(a.hash());
  });

  it('are ignored deterministically when they do not apply', () => {
    const a = simAt(0, 0);
    const b = simAt(0, 0);
    const ignored = [
      { type: 'Place', item: ItemId.WoodenChest, x: 0, y: 0, dir: North },
      { type: 'Place', item: ItemId.WoodenChest, x: 50, y: 0, dir: North },
      { type: 'Place', item: ItemId.Coal, x: 2, y: 0, dir: North },
      { type: 'Place', item: 0, x: 2, y: 0, dir: North },
      { type: 'Place', item: 0xffff, x: 2, y: 0, dir: North },
      { type: 'Place', item: ItemId.WoodenChest, x: 2 ** 31 - 1, y: -(2 ** 31), dir: South },
      { type: 'Remove', x: 3, y: 3 },
      { type: 'Remove', x: 2 ** 31 - 1, y: 0 },
      { type: 'Rotate', x: -5, y: 7 },
      { type: 'Rotate', x: -(2 ** 31), y: 2 ** 31 - 1 },
    ] as const;
    for (const c of ignored) {
      b.enqueue({ ...cmd, ...c });
      // Unknown players are ignored too.
      b.enqueue({ ...cmd, ...c, playerId: 9 });
    }
    a.step();
    b.step();
    expect(b.state.entities.count).toBe(0);
    expect(b.hash()).toBe(a.hash());
  });

  it('reject malformed build commands', () => {
    const sim = simAt(0, 0);
    expect(() =>
      sim.enqueue({ ...cmd, type: 'Place', item: ItemId.WoodenChest, x: 0.5, y: 0, dir: North }),
    ).toThrow(TypeError);
    expect(() => sim.enqueue({ ...cmd, type: 'Place', item: -1, x: 0, y: 0, dir: North })).toThrow(
      TypeError,
    );
    expect(() =>
      sim.enqueue({
        ...cmd,
        type: 'Place',
        item: ItemId.WoodenChest,
        x: 0,
        y: 0,
        dir: 4 as Direction,
      }),
    ).toThrow(TypeError);
    expect(() => sim.enqueue({ ...cmd, type: 'Remove', x: 0, y: 2 ** 31 })).toThrow(TypeError);
    expect(() => sim.enqueue({ ...cmd, type: 'Rotate', x: NaN, y: 0 })).toThrow(TypeError);
  });
});

/** A per-type table that records the hooks it receives. */
class RecordingTable implements EntityTypeTable {
  readonly type = EntityTypeId.WoodenChest;
  readonly log: string[] = [];
  readonly stored = new Map<number, ItemStack[]>();

  add(id: number): void {
    this.log.push(`add ${String(id)}`);
    this.stored.set(id, []);
  }
  contents(id: number): readonly ItemStack[] {
    return this.stored.get(id) ?? [];
  }
  remove(id: number): void {
    this.log.push(`remove ${String(id)}`);
    this.stored.delete(id);
  }
  entityPlaced(id: number): void {
    this.log.push(`placed ${String(id)}`);
  }
  entityRemoved(id: number): void {
    this.log.push(`removed ${String(id)}`);
  }
  wake(id: number): void {
    this.log.push(`wake ${String(id)}`);
  }
  hashInto(h: number): number {
    return (h ^ this.stored.size) >>> 0;
  }
}

describe('per-type tables', () => {
  it('get hooks on place and remove, refund their contents, and receive wake-ups', () => {
    const sim = simAt(0, 0);
    const table = new RecordingTable();
    // Swap in an `Entities` with the table registered.
    const entities = new Entities([table]);
    const state: SimState = { ...sim.state, entities };
    expect(place(state, ItemId.WoodenChest, 2, 0)).toBe(BuildResult.Ok);
    expect(place(state, ItemId.TransportBelt, 3, 0)).toBe(BuildResult.Ok);
    expect(table.log).toEqual(['add 1', 'placed 1', 'placed 2']);

    // The chest waits on the belt; removing the belt wakes it.
    entities.wake.watch(1, 2);
    entities.notify(2);
    expect(table.log.at(-1)).toBe('wake 1');
    expect(removeEntity(state, 0, 3, 0)).toBe(BuildResult.Ok);
    expect(table.log.slice(-2)).toEqual(['removed 2', 'wake 1']);
    expect(entities.wake.size).toBe(0);

    // Contents come back with the chest.
    table.stored.set(1, [{ item: ItemId.Coal, count: 7 }]);
    const inv = state.players.inventory(0);
    const coal = inv.count(ItemId.Coal);
    expect(removeEntity(state, 0, 2, 0)).toBe(BuildResult.Ok);
    expect(table.log.slice(-2)).toEqual(['removed 1', 'remove 1']);
    expect(inv.count(ItemId.Coal)).toBe(coal + 7);
    expect(inv.count(ItemId.WoodenChest)).toBe(2);
  });

  it('refuse a removal whose contents do not fit', () => {
    const sim = simAt(0, 0);
    const table = new RecordingTable();
    const state: SimState = { ...sim.state, entities: new Entities([table]) };
    place(state, ItemId.WoodenChest, 2, 0);
    const inv = state.players.inventory(0);
    // The chest itself still fits on its stack, but its contents need a free slot.
    inv.add(ItemId.Stone, inv.spaceFor(ItemId.Stone));
    expect(inv.spaceFor(ItemId.WoodenChest)).toBeGreaterThan(0);
    expect(inv.spaceFor(ItemId.IronOre)).toBe(0);
    table.stored.set(1, [{ item: ItemId.IronOre, count: 1 }]);
    expect(removeEntity(state, 0, 2, 0)).toBe(BuildResult.InventoryFull);
    expect(state.entities.count).toBe(1);
    expect(inv.slots).toBe(PLAYER_INVENTORY_SLOTS);
  });

  it('must be unique per type', () => {
    expect(() => new Entities([new RecordingTable(), new RecordingTable()])).toThrow(RangeError);
  });
});

describe('encodeEntities', () => {
  it('encodes the entities whose origin lies in the chunk range', () => {
    const { state } = simAt(0, 0);
    place(state, ItemId.TransportBelt, 2, 0, South);
    place(state, ItemId.StoneFurnace, -2, -2);
    const all = encodeEntities(state, { cx0: -1, cy0: -1, cx1: 0, cy1: 0 });
    expect(all.length).toBe(2 * ENTITY_STRIDE);
    const records = [0, 1].map((i) =>
      Array.from(all.subarray(i * ENTITY_STRIDE, (i + 1) * ENTITY_STRIDE)),
    );
    // Chunks row by row: (-1, -1) first.
    expect(records[0]![EntityField.type]).toBe(EntityTypeId.StoneFurnace);
    expect(records[0]!.slice(EntityField.x, EntityField.dir + 1)).toEqual([-2, -2, North]);
    // A fresh furnace waits for input; belts have no machine state.
    expect(records[0]![EntityField.status]).toBe(MachineState.NoInput);
    expect(records[1]).toEqual([1, EntityTypeId.TransportBelt, 2, 0, South, MachineState.Idle]);
    expect(encodeEntities(state, { cx0: 0, cy0: 0, cx1: 0, cy1: 0 }).length).toBe(ENTITY_STRIDE);
    expect(encodeEntities(state, null).length).toBe(0);
  });
});
