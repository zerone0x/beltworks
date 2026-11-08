import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { beltTable } from '../../src/sim/belts/belts';
import { Direction } from '../../src/sim/entities/direction';
import {
  DETERMINISM_TICKS,
  buildDeterminismScript,
  createDeterminismSim,
} from '../../src/sim/scenarios/determinism';
import { SaveError } from '../../src/sim/save/codec';
import {
  SAVE_VERSION,
  decodeSave,
  encodeSave,
  loadSim,
  readSaveMeta,
  saveSim,
} from '../../src/sim/save/save';
import { Sim } from '../../src/sim/tick';
import { DETERMINISM_EXPECTED_HASH } from './determinism.expected';
import { expectRoundTrip, reload, stepTogether } from './saveRoundTrip';

const hex = (h: number): string => `0x${h.toString(16).padStart(8, '0')}`;

/** The determinism scenario with its whole script queued, before any tick. */
function scenario(): Sim {
  const sim = createDeterminismSim();
  for (const cmd of buildDeterminismScript()) sim.enqueue(cmd);
  return sim;
}

/**
 * Ticks at which the relay run below saves and reloads: the scripted walks,
 * every few ticks through the scripted builds (chains, poles, steam,
 * belts of every tier, undergrounds, splitters, assemblers, labs: ticks 905
 * to 960), and then through the random phase to the end.
 */
const CHECKPOINTS = [
  0, 1, 150, 600, 900, 905, 910, 915, 920, 925, 930, 935, 940, 945, 950, 955, 960, 1_000, 1_200,
  1_450, 1_700, 2_000, 2_500, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 9_500, 9_999,
];

describe('save round trip', () => {
  it('relays the determinism scenario through saves without changing a single tick', () => {
    // `reference` runs straight through; `relay` is replaced by a loaded copy
    // of itself at every checkpoint. Their hashes must agree after every tick,
    // and the relay must end on the scenario's expected hash.
    const reference = scenario();
    let relay = scenario();
    let next = 0;
    while (reference.tick < DETERMINISM_TICKS) {
      if (CHECKPOINTS[next] === relay.tick) {
        relay = reload(relay);
        next++;
      }
      const until = CHECKPOINTS[next] ?? DETERMINISM_TICKS;
      stepTogether(reference, relay, until - relay.tick);
    }
    expect(next).toBe(CHECKPOINTS.length);
    expect(hex(relay.hash())).toBe(hex(DETERMINISM_EXPECTED_HASH));
  }, 120_000);

  it('keeps commands queued for later ticks', () => {
    const sim = new Sim({ seed: 7 });
    sim.enqueue({ type: 'Move', playerId: 0, dx: 1, dy: 0, tick: 5 });
    sim.enqueue({
      type: 'Place',
      playerId: 0,
      item: ItemId.WoodenChest,
      x: 3,
      y: 0,
      dir: Direction.North,
      tick: 9,
    });
    const copy = reload(sim);
    expect(copy.pendingCommands).toBe(2);
    stepTogether(sim, copy, 20);
    expect(copy.state.entities.count).toBe(1);
  });

  it('round-trips a new game, and through gzip', async () => {
    const sim = new Sim({ seed: 42 });
    expectRoundTrip(sim, 60);
    const { gzip, gunzip } = await import('../../src/save/compress');
    const packed = await gzip(saveSim(sim));
    const copy = loadSim(await gunzip(packed));
    expect(copy.hash()).toBe(sim.hash());
  });

  it('says a save is damaged when its gzip stream is corrupt or cut off', async () => {
    const { gzip, gunzip, DAMAGED_SAVE_MESSAGE } = await import('../../src/save/compress');
    const packed = await gzip(saveSim(new Sim({ seed: 42 })));
    // Damaged inside the stream, past the 10-byte gzip header.
    const corrupt = packed.slice();
    for (let i = 20; i < 40; i++) corrupt[i]! ^= 0xff;
    await expect(gunzip(corrupt)).rejects.toThrow(DAMAGED_SAVE_MESSAGE);
    await expect(gunzip(packed.slice(0, packed.length >> 1))).rejects.toThrow(DAMAGED_SAVE_MESSAGE);
  });

  it('round-trips a splitter merging a full and a sparse input, mid-turn', () => {
    // An express splitter with fast inputs and an express output in front of
    // half A: input A is full, input B gets an item per lane every 16 ticks,
    // so half A keeps making way for B's items (its yield bits and held items
    // change all the time). The relay is reloaded every few ticks.
    const build = () => {
      const sim = new Sim({ seed: 5 });
      const { entities } = sim.state;
      entities.add(ENTITIES[EntityTypeId.ExpressSplitter], 2, 0, Direction.East);
      for (const [x, y, proto] of [
        [0, 0, ENTITIES[EntityTypeId.FastTransportBelt]],
        [1, 0, ENTITIES[EntityTypeId.FastTransportBelt]],
        [0, 1, ENTITIES[EntityTypeId.FastTransportBelt]],
        [1, 1, ENTITIES[EntityTypeId.FastTransportBelt]],
        [3, 0, ENTITIES[EntityTypeId.ExpressTransportBelt]],
        [4, 0, ENTITIES[EntityTypeId.ExpressTransportBelt]],
      ] as const) {
        entities.add(proto, x, y, Direction.East);
      }
      return sim;
    };
    /** Feeds and empties the belts of `sim` as the scene does after `tick`, the same way every run. */
    const tend = (sim: Sim, tick: number) => {
      const table = beltTable(sim.state.entities)!;
      const [inA, inB, out] = [
        [0, 0],
        [0, 1],
        [3, 0],
      ].map(([x, y]) => table.line(table.beltLine(sim.state.entities.at(x!, y!)))!);
      for (const lane of [0, 1]) {
        while (table.takeAt(out!.id, lane, 0, out!.speed - 1) !== 0);
        const l = inA!.lanes[lane as 0 | 1];
        table.insertAt(inA!.id, lane, l.count === 0 ? inA!.length : l.total + 64, ItemId.IronPlate);
        if (tick % 16 === 0) table.insertAt(inB!.id, lane, inB!.length, ItemId.Coal);
      }
    };
    const reference = build();
    let relay = build();
    for (let t = 0; t < 600; t++) {
      if (t >= 100 && t % 7 === 0) relay = reload(relay);
      tend(reference, t);
      tend(relay, t);
      stepTogether(reference, relay, 1);
    }
    const out = (sim: Sim) =>
      beltTable(sim.state.entities)!.itemsOwnedBy(sim.state.entities.at(3, 0));
    expect(out(relay)).toEqual(out(reference));
  });

  it('describes a save in its meta section', () => {
    const sim = scenario();
    for (let i = 0; i < 1_000; i++) sim.step();
    const meta = readSaveMeta(saveSim(sim));
    expect(meta).toEqual({
      version: SAVE_VERSION,
      tick: 1_000,
      seed: sim.state.seed,
      players: 3,
      entities: sim.state.entities.count,
    });
  });
});

describe('save format', () => {
  const bytes = saveSim(new Sim({ seed: 3 }));

  it('refuses saves from newer versions with a clear message', () => {
    const doc = decodeSave(bytes);
    doc.version = SAVE_VERSION + 1;
    expect(() => loadSim(encodeSave(doc))).toThrow(/newer version of Beltworks/);
  });

  it('refuses files that are not saves, and damaged or truncated ones', () => {
    expect(() => loadSim(new TextEncoder().encode('hello, world!!'))).toThrow(
      /Not a Beltworks save/,
    );
    const damaged = bytes.slice();
    damaged[damaged.length >> 1]! ^= 0x40;
    expect(() => loadSim(damaged)).toThrow(/damaged/);
    expect(() => loadSim(bytes.subarray(0, bytes.length - 9))).toThrow(SaveError);
  });

  it('refuses saves with missing or unknown sections', () => {
    const missing = decodeSave(bytes);
    missing.sections.delete('world');
    expect(() => loadSim(encodeSave(missing))).toThrow(/missing its "world" section/);
    const extra = decodeSave(bytes);
    extra.sections.set('table:flux-capacitor', new Uint8Array(4));
    expect(() => loadSim(encodeSave(extra))).toThrow(/unknown "table:flux-capacitor"/);
  });
});
