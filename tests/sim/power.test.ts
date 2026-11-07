import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId, SAT_ONE } from '../../src/data/entities';
import { ItemId, type ItemStack } from '../../src/data/items';
import { BuildResult, placeEntity, removeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { Entities } from '../../src/sim/entities/entities';
import type { EntityTypeTable } from '../../src/sim/entities/table';
import { mulDiv, tileCenter } from '../../src/sim/fixed';
import {
  MAX_SUPPLY_RADIUS,
  MAX_WIRE_REACH,
  polesConnect,
  supplyRect,
} from '../../src/sim/power/geometry';
import { PowerGrid, powerGrid } from '../../src/sim/power/grid';
import { poweredEnergy, producerShare, satisfactionFor } from '../../src/sim/power/solver';
import { Rng } from '../../src/sim/rng';
import { SYSTEMS, Sim } from '../../src/sim/tick';

const POLE = ENTITIES[EntityTypeId.SmallElectricPole];
const { North } = Direction;

/** A fake electric consumer on the wooden chest's 1×1 footprint: demands what the test sets. */
class FakeConsumers implements EntityTypeTable {
  // Test-only tables are never saved.
  save(): void {}
  load(): void {}
  readonly type = EntityTypeId.WoodenChest;
  readonly demand = new Map<number, number>();
  add(): void {}
  remove(): void {}
  contents(): readonly ItemStack[] {
    return [];
  }
  hashInto(h: number): number {
    return h;
  }
  powerDemand(id: number): number {
    return this.demand.get(id) ?? 0;
  }
}

/** A fake electric producer on the stone furnace's 2×2 footprint: offers what the test sets. */
class FakeProducers implements EntityTypeTable {
  // Test-only tables are never saved.
  save(): void {}
  load(): void {}
  readonly type = EntityTypeId.StoneFurnace;
  readonly max = new Map<number, number>();
  /** Every `powerDraw` call: `[id, joules]`. */
  readonly draws: [number, number][] = [];
  add(): void {}
  remove(): void {}
  contents(): readonly ItemStack[] {
    return [];
  }
  hashInto(h: number): number {
    return h;
  }
  powerMaxOutput(id: number): number {
    return this.max.get(id) ?? 0;
  }
  powerDraw(id: number, joules: number): void {
    this.draws.push([id, joules]);
  }
}

function world() {
  const grid = new PowerGrid();
  const consumers = new FakeConsumers();
  const producers = new FakeProducers();
  const entities = new Entities([grid, consumers, producers]);
  const pole = (x: number, y: number) => entities.add(POLE, x, y, North);
  const consumer = (x: number, y: number, demand = 0) => {
    const id = entities.add(ENTITIES[EntityTypeId.WoodenChest], x, y, North);
    consumers.demand.set(id, demand);
    return id;
  };
  const producer = (x: number, y: number, max = 0) => {
    const id = entities.add(ENTITIES[EntityTypeId.StoneFurnace], x, y, North);
    producers.max.set(id, max);
    return id;
  };
  return { grid, consumers, producers, entities, pole, consumer, producer };
}

/** Partition of `poles` into networks, as sorted lists of pole ids, sorted. */
function partition(grid: PowerGrid, poles: readonly number[]): number[][] {
  const byNet = new Map<number, number[]>();
  for (const p of poles) {
    const net = grid.networkOfPole(p);
    expect(net).toBeGreaterThan(0);
    const list = byNet.get(net) ?? [];
    list.push(p);
    byNet.set(net, list);
  }
  return [...byNet.values()].map((l) => l.sort((a, b) => a - b)).sort((a, b) => a[0]! - b[0]!);
}

describe('pole geometry', () => {
  it('connects small poles whose centers are at most 7 tiles apart (squared distance ≤ 49)', () => {
    const at = (dx: number, dy: number) => polesConnect(POLE, 0, 0, POLE, dx, dy);
    expect(at(7, 0)).toBe(true);
    expect(at(0, -7)).toBe(true);
    expect(at(4, 5)).toBe(true); // 41
    expect(at(7, 1)).toBe(false); // 50
    expect(at(5, 5)).toBe(false); // 50
    expect(at(8, 0)).toBe(false);
    expect(MAX_WIRE_REACH).toBe(7);
  });

  it('gives a small pole a 5×5 supply area centered on it', () => {
    expect(supplyRect(POLE, 3, -4)).toEqual({ x0: 1, y0: -6, x1: 5, y1: -2 });
    expect(MAX_SUPPLY_RADIUS).toBe(2);
  });
});

describe('electric networks', () => {
  it('wires poles in reach to each other and puts them in one network', () => {
    const { grid, pole } = world();
    const a = pole(0, 0);
    const b = pole(7, 0);
    const c = pole(15, 0); // 8 from b: alone
    expect(grid.neighbours(a)).toEqual([b]);
    expect(grid.neighbours(b)).toEqual([a]);
    expect(grid.neighbours(c)).toEqual([]);
    expect(grid.networkOfPole(a)).toBe(grid.networkOfPole(b));
    expect(grid.networkOfPole(c)).not.toBe(grid.networkOfPole(a));
    expect(grid.networkCount).toBe(2);
    expect(grid.network(grid.networkOfPole(a))?.poles).toBe(2);
  });

  it('lists every pole in reach, in id order', () => {
    const { grid, pole } = world();
    const centre = pole(0, 0);
    const ring = [pole(0, -7), pole(7, 0), pole(-4, 5), pole(3, 3), pole(-7, -2)];
    expect(grid.neighbours(centre)).toEqual(ring.slice(0, 4));
    expect(grid.neighbours(ring[4]!)).toEqual([]);
  });

  it('unwires a removed pole', () => {
    const { grid, entities, pole } = world();
    const a = pole(0, 0);
    const b = pole(5, 0);
    const c = pole(4, 5);
    expect(grid.neighbours(b)).toEqual([a, c]);
    entities.remove(b);
    expect(grid.neighbours(a)).toEqual([c]);
    expect(grid.neighbours(c)).toEqual([a]);
    expect(grid.neighbours(b)).toEqual([]);
    expect(grid.networkOfPole(b)).toBe(0);
    expect(grid.poleCount).toBe(2);
    expect(grid.networkCount).toBe(1);
  });

  it('merges networks when a pole bridges them, keeping the lowest network id', () => {
    const { grid, pole } = world();
    const a = pole(0, 0);
    const c = pole(14, 0);
    const d = pole(14, 7);
    const left = grid.networkOfPole(a);
    const right = grid.networkOfPole(c);
    expect(left).toBeLessThan(right);
    expect(grid.networkOfPole(d)).toBe(right);
    const b = pole(7, 0);
    for (const p of [a, b, c, d]) expect(grid.networkOfPole(p)).toBe(left);
    expect(grid.networkIds()).toEqual([left]);
    expect(grid.network(left)?.poles).toBe(4);
    expect(grid.network(right)).toBeUndefined();
  });

  it('splits a network when its bridging pole goes: the piece of the lowest neighbour keeps the id', () => {
    const { grid, entities, pole } = world();
    const a = pole(0, 0);
    const b = pole(7, 0);
    const c = pole(14, 0);
    const d = pole(7, 7);
    const net = grid.networkOfPole(b);
    expect(grid.networkCount).toBe(1);
    entities.remove(b);
    expect(grid.networkCount).toBe(3);
    expect(grid.networkOfPole(a)).toBe(net);
    const others = [grid.networkOfPole(c), grid.networkOfPole(d)];
    expect(new Set([net, ...others]).size).toBe(3);
    expect(Math.min(...others)).toBeGreaterThan(net);
    expect(grid.network(net)?.poles).toBe(1);
  });

  it('drops the network of a removed lone pole', () => {
    const { grid, entities, pole } = world();
    const a = pole(0, 0);
    expect(grid.networkCount).toBe(1);
    entities.remove(a);
    expect(grid.networkCount).toBe(0);
    expect(grid.networkIds()).toEqual([]);
  });

  it('keeps networks equal to the connected components through random builds and removals', () => {
    const { grid, entities, pole } = world();
    const rng = Rng.fromSeed(0xbeef);
    const live: number[] = [];
    for (let step = 0; step < 600; step++) {
      if (live.length > 0 && rng.nextInt(3) === 0) {
        const id = live.splice(rng.nextInt(live.length), 1)[0]!;
        entities.remove(id);
      } else {
        const x = rng.nextInt(40);
        const y = rng.nextInt(40);
        if (entities.at(x, y) === 0) live.push(pole(x, y));
      }
      // Brute force: components of the "within reach" graph over the live poles.
      const pos = (id: number) => [entities.store.x(id), entities.store.y(id)] as const;
      const expected: number[][] = [];
      const seen = new Set<number>();
      for (const start of [...live].sort((p, q) => p - q)) {
        if (seen.has(start)) continue;
        const piece = [start];
        seen.add(start);
        for (let k = 0; k < piece.length; k++) {
          const [px, py] = pos(piece[k]!);
          for (const q of live) {
            const [qx, qy] = pos(q);
            if (!seen.has(q) && polesConnect(POLE, px, py, POLE, qx, qy)) {
              seen.add(q);
              piece.push(q);
            }
          }
        }
        expected.push(piece.sort((p, q) => p - q));
      }
      expect(partition(grid, live)).toEqual(expected);
      expect(grid.networkCount).toBe(expected.length);
      for (const piece of expected) {
        expect(grid.network(grid.networkOfPole(piece[0]!))?.poles).toBe(piece.length);
      }
    }
  });

  it('hashes the same however often networks were looked up (path compression is invisible)', () => {
    const build = () => {
      const w = world();
      const poles = [w.pole(0, 0), w.pole(5, 0), w.pole(10, 0), w.pole(15, 0), w.pole(20, 0)];
      w.entities.remove(poles[2]!);
      w.pole(10, 1);
      return { ...w, poles };
    };
    const quiet = build();
    const busy = build();
    for (const p of busy.poles) busy.grid.networkOfPole(p);
    expect(busy.entities.hashInto(1)).toBe(quiet.entities.hashInto(1));
  });
});

describe('electric entity membership', () => {
  it('joins the network of a pole whose supply area covers it, and leaves when the pole goes', () => {
    const { grid, entities, pole, consumer } = world();
    const inside = consumer(2, 2);
    const outside = consumer(3, 0);
    expect(grid.networkOf(inside)).toBe(0);
    const p = pole(0, 0);
    expect(grid.member(inside)).toMatchObject({ pole: p, network: grid.networkOfPole(p) });
    expect(grid.networkOf(outside)).toBe(0);
    // Placed after the pole, inside its area.
    const late = consumer(-2, -1);
    expect(grid.networkOf(late)).toBe(grid.networkOfPole(p));
    entities.remove(p);
    expect(grid.networkOf(inside)).toBe(0);
    expect(grid.networkOf(late)).toBe(0);
    expect(grid.memberCount).toBe(3);
    entities.remove(late);
    expect(grid.memberCount).toBe(2);
    expect(grid.member(late)).toBeUndefined();
  });

  it('counts any covered tile of a larger entity', () => {
    const { grid, pole, producer } = world();
    const engine = producer(0, 0); // tiles (0..1, 0..1)
    const p = pole(3, 3); // area (1..5, 1..5) covers (1, 1)
    expect(grid.networkOf(engine)).toBe(grid.networkOfPole(p));
  });

  it('ties an entity covered by two networks to the lowest pole id, and re-ties it when that pole goes', () => {
    const { grid, entities, pole, producer } = world();
    // Covered at (0, 0) by b's area and at (1, 1) by a's; the poles are 50 apart squared: not wired.
    const b = pole(-2, -2);
    const a = pole(3, 3);
    expect(grid.neighbours(a)).toEqual([]);
    const engine = producer(0, 0);
    expect(grid.member(engine)).toMatchObject({ pole: b, network: grid.networkOfPole(b) });
    entities.remove(b);
    expect(grid.member(engine)).toMatchObject({ pole: a, network: grid.networkOfPole(a) });
  });

  it('follows its pole into a merged network and out of a split one', () => {
    const { grid, entities, pole, consumer } = world();
    const a = pole(0, 0);
    const c = pole(14, 0);
    const e = consumer(13, 1);
    expect(grid.networkOf(e)).toBe(grid.networkOfPole(c));
    const b = pole(7, 0);
    expect(grid.networkOf(e)).toBe(grid.networkOfPole(a));
    entities.remove(b);
    expect(grid.networkOf(e)).toBe(grid.networkOfPole(c));
    expect(grid.networkOf(e)).not.toBe(grid.networkOfPole(a));
  });
});

describe('power solver math', () => {
  it('computes satisfaction as min(1, supply / demand) in 1/65536, rounded down', () => {
    expect(SAT_ONE).toBe(65_536);
    expect(satisfactionFor(100, 0)).toBe(0);
    expect(satisfactionFor(0, 0)).toBe(0);
    expect(satisfactionFor(0, 5)).toBe(SAT_ONE);
    expect(satisfactionFor(100, 100)).toBe(SAT_ONE);
    expect(satisfactionFor(100, 250)).toBe(SAT_ONE);
    expect(satisfactionFor(100, 50)).toBe(32_768);
    expect(satisfactionFor(3, 1)).toBe(21_845); // 21 845.33…
    expect(satisfactionFor(3, 2)).toBe(43_690); // 43 690.67…
    expect(satisfactionFor(1_000_000, 1)).toBe(0); // 0.065…
    expect(satisfactionFor(4_000_000_000, 3_999_999_999)).toBe(65_535);
  });

  it('splits the load among producers in proportion, adding up exactly and never over a maximum', () => {
    const rng = Rng.fromSeed(7);
    for (let round = 0; round < 500; round++) {
      const maxes = Array.from({ length: 1 + rng.nextInt(6) }, () => rng.nextInt(40_000));
      const supply = maxes.reduce((s, m) => s + m, 0);
      const load = supply === 0 ? 0 : rng.nextInt(supply + 1);
      let before = 0;
      let total = 0;
      for (const max of maxes) {
        const share = producerShare(load, supply, before, max);
        expect(Number.isInteger(share)).toBe(true);
        expect(share).toBeGreaterThanOrEqual(0);
        expect(share).toBeLessThanOrEqual(max);
        before += max;
        total += share;
      }
      expect(total).toBe(load);
    }
    // 1 000 J from three equal producers: 333, 333, 334.
    expect([0, 1000, 2000].map((b) => producerShare(1000, 3000, b, 1000))).toEqual([333, 333, 334]);
    // At full load each delivers its maximum.
    expect(producerShare(30_000, 30_000, 15_000, 15_000)).toBe(15_000);
  });

  it('scales a consumer by satisfaction, rounding down', () => {
    expect(poweredEnergy(1_500, SAT_ONE)).toBe(1_500);
    expect(poweredEnergy(1_500, 32_768)).toBe(750);
    expect(poweredEnergy(7, 21_845)).toBe(2);
    expect(poweredEnergy(220, 0)).toBe(0);
  });

  it('uses exact integer division even where doubles would round', () => {
    expect(mulDiv(4_000_000_000, 65_536, 4_000_000_001)).toBe(65_535);
    const big = (a: number, b: number, c: number) => Number((BigInt(a) * BigInt(b)) / BigInt(c));
    const rng = Rng.fromSeed(11);
    for (let i = 0; i < 1000; i++) {
      const a = rng.nextInt(0x7fff_ffff) * (1 + rng.nextInt(2));
      const b = rng.nextInt(0x7fff_ffff);
      const c = 1 + rng.nextInt(0x7fff_ffff);
      expect(mulDiv(a, b, c)).toBe(big(a, b, c));
    }
    expect(mulDiv(9_007_199_254_740_991, 1, 3)).toBe(3_002_399_751_580_330);
  });
});

describe('power solver', () => {
  it('runs as the second system of every tick, right after the commands', () => {
    expect(SYSTEMS.map((s) => s.name).slice(0, 3)).toEqual(['commands', 'power', 'drills']);
  });

  it('gives consumers satisfaction 0 when there are no producers', () => {
    const { grid, entities, pole, consumer } = world();
    const p = pole(0, 0);
    const c = consumer(1, 0, 1_500);
    grid.update(entities);
    expect(grid.satisfaction(c)).toBe(0);
    expect(grid.network(grid.networkOfPole(p))).toMatchObject({
      demand: 1_500,
      supply: 0,
      satisfaction: 0,
      load: 0,
    });
  });

  it('computes satisfaction per network and has producers deliver exactly the load', () => {
    const { grid, entities, consumers, producers, pole, consumer, producer } = world();
    pole(0, 0);
    const drill = consumer(1, 0, 1_500);
    const drill2 = consumer(-1, 0, 1_500);
    const inserter = consumer(0, 1, 220);
    const big = producer(1, -2, 1_200);
    const small = producer(-2, -2, 800);
    grid.update(entities);
    // 2 000 J for 3 220 J of demand: floor(2000 · 65536 / 3220) = 40 705.
    for (const c of [drill, drill2, inserter]) expect(grid.satisfaction(c)).toBe(40_705);
    expect(producers.draws).toEqual([
      [big, 1_200],
      [small, 800],
    ]);
    expect(grid.member(drill)).toMatchObject({ demand: 1_500, maxOutput: 0, drawn: 0 });
    expect(grid.member(big)).toMatchObject({ demand: 0, maxOutput: 1_200, drawn: 1_200 });
    expect(poweredEnergy(1_500, grid.satisfaction(drill))).toBe(931);

    // Less demand than supply: full speed, producers share the load in proportion.
    producers.draws.length = 0;
    consumers.demand.set(drill, 1_000);
    consumers.demand.set(drill2, 0);
    consumers.demand.set(inserter, 0);
    grid.update(entities);
    expect(grid.satisfaction(drill)).toBe(SAT_ONE);
    expect(producers.draws).toEqual([
      [big, 600],
      [small, 400],
    ]);
  });

  it('keeps separate networks apart and tells unconnected producers to deliver nothing', () => {
    const { grid, entities, producers, pole, consumer, producer } = world();
    const left = pole(0, 0);
    const right = pole(20, 0);
    const lc = consumer(1, 0, 600);
    const rc = consumer(21, 0, 600);
    const lp = producer(-2, 1, 300);
    const lost = producer(10, 10, 5_000);
    grid.update(entities);
    expect(grid.satisfaction(lc)).toBe(32_768);
    expect(grid.satisfaction(rc)).toBe(0);
    expect(grid.network(grid.networkOfPole(left))?.load).toBe(300);
    expect(grid.network(grid.networkOfPole(right))?.load).toBe(0);
    expect(producers.draws).toEqual([
      [lp, 300],
      [lost, 0],
    ]);
    expect(grid.member(lost)).toMatchObject({ network: 0, maxOutput: 0, drawn: 0 });
  });

  it('rejects power hooks that report anything but non-negative integer joules', () => {
    const { grid, entities, pole, consumer } = world();
    pole(0, 0);
    consumer(1, 0, 1.5);
    expect(() => grid.update(entities)).toThrow(RangeError);
  });
});

describe('small electric poles in the game', () => {
  const kit: ItemStack[] = [{ item: ItemId.SmallElectricPole, count: 10 }];
  const simAt = (tx: number, ty: number) => {
    const sim = new Sim({ seed: 1, startingKit: kit });
    sim.state.players.x[0] = tileCenter(tx);
    sim.state.players.y[0] = tileCenter(ty);
    return sim;
  };

  it('are placed and picked up like any entity, and form networks', () => {
    const sim = simAt(0, 0);
    const { state } = sim;
    const inv = state.players.inventory(0);
    expect(placeEntity(state, 0, ItemId.SmallElectricPole, 3, 0, North)).toBe(BuildResult.Ok);
    expect(placeEntity(state, 0, ItemId.SmallElectricPole, -4, 0, North)).toBe(BuildResult.Ok);
    expect(inv.count(ItemId.SmallElectricPole)).toBe(8);
    const grid = powerGrid(state.entities)!;
    const a = state.entities.at(3, 0);
    const b = state.entities.at(-4, 0);
    expect(grid.neighbours(a)).toEqual([b]);
    const before = sim.hash();
    expect(removeEntity(state, 0, 3, 0)).toBe(BuildResult.Ok);
    expect(inv.count(ItemId.SmallElectricPole)).toBe(9);
    expect(grid.neighbours(b)).toEqual([]);
    expect(sim.hash()).not.toBe(before);
  });
});
