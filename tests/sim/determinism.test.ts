import { describe, expect, it } from 'vitest';
import { EntityTypeId } from '../../src/data/entities';
import { ItemId, MINED_ITEM } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';
import { Direction } from '../../src/sim/entities/direction';
import {
  DETERMINISM_BUILD_TICKS,
  DETERMINISM_PLAYERS,
  DETERMINISM_SCRIPTED_TICKS,
  DETERMINISM_SEED,
  DETERMINISM_TICKS,
  buildDeterminismScript,
  runDeterminismScenario,
} from '../../src/sim/scenarios/determinism';
import { Sim } from '../../src/sim/tick';
import { startingPatches } from '../../src/sim/world/generate';
import { DETERMINISM_EXPECTED_HASH } from './determinism.expected';

const hex = (h: number): string => `0x${h.toString(16).padStart(8, '0')}`;

/** Runs the scenario, recording the hash every `every` ticks. */
function hashTrace(every: number): number[] {
  const sim = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
  for (const cmd of buildDeterminismScript()) {
    sim.enqueue(cmd);
  }
  const trace: number[] = [];
  for (let i = 0; i < DETERMINISM_TICKS; i++) {
    sim.step();
    if (sim.tick % every === 0) {
      trace.push(sim.hash());
    }
  }
  return trace;
}

describe('determinism', () => {
  it('produces the same hash when run twice', () => {
    const a = runDeterminismScenario();
    const b = runDeterminismScenario();
    expect(a.tick).toBe(DETERMINISM_TICKS);
    expect(a.commands).toBeGreaterThan(1000);
    expect(hex(b.hash)).toBe(hex(a.hash));
  });

  it('walks every player to an ore patch and mines it', () => {
    const script = buildDeterminismScript();
    const scripted = script.filter((c) => c.tick < DETERMINISM_SCRIPTED_TICKS);
    // The scripted phase fits in its window (nothing got cut off).
    expect(scripted.some((c) => c.type === 'MineStop' && c.playerId === 1)).toBe(true);

    const sim = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
    script.forEach((c) => sim.enqueue(c));
    for (let i = 0; i < DETERMINISM_SCRIPTED_TICKS; i++) {
      sim.step();
    }
    const patches = startingPatches(DETERMINISM_SEED);
    for (let id = 0; id < DETERMINISM_PLAYERS; id++) {
      const inv = sim.state.players.inventory(id);
      const item = MINED_ITEM[patches[id]!.ore];
      const kit = STARTING_KIT.find((s) => s.item === item)?.count ?? 0;
      // 300 + 150 ticks of mining at 30 ticks per unit, on top of the starting kit.
      expect(inv.count(item) - kit).toBe(15);
    }
    // The mined patches show up in the world hash.
    expect(sim.state.world.chunkVersion(0, 0)).toBeGreaterThan(0);
    expect(runDeterminismScenario().itemsMined).toBeGreaterThanOrEqual(45);
  });

  it('builds at the spawn: places, rotates and removes, and ignores invalid commands', () => {
    const sim = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    for (let i = 0; i < DETERMINISM_BUILD_TICKS; i++) {
      sim.step();
    }
    const { entities } = sim.state;
    const at = (x: number, y: number) => {
      const id = entities.at(x, y);
      return id && [entities.store.type(id), entities.store.dir(id)];
    };
    expect(entities.count).toBe(4);
    expect(at(2, -2)).toBe(0); // placed, then removed
    expect(at(4, 1)).toEqual([EntityTypeId.StoneFurnace, Direction.North]);
    expect(at(1, 2)).toEqual([EntityTypeId.TransportBelt, Direction.South]);
    expect(at(-3, 1)).toEqual([EntityTypeId.BurnerMiningDrill, Direction.North]);
    expect(at(-1, 2)).toEqual([EntityTypeId.BurnerInserter, Direction.East]);
    expect(at(0, 0)).toBe(0);
    expect(at(15, 0)).toBe(0);
    const inv = sim.state.players.inventory(0);
    expect(inv.count(ItemId.WoodenChest)).toBe(2);
    expect(inv.count(ItemId.StoneFurnace)).toBe(1);
    expect(inv.count(ItemId.TransportBelt)).toBe(9);
    // The random phase builds too.
    expect(runDeterminismScenario().entities).toBeGreaterThan(4);
  });

  it('matches the expected hash shared with the Chromium test', () => {
    expect(hex(runDeterminismScenario().hash)).toBe(hex(DETERMINISM_EXPECTED_HASH));
  });

  it('produces identical intermediate hashes, and they keep changing', () => {
    const a = hashTrace(100);
    const b = hashTrace(100);
    expect(b).toEqual(a);
    expect(new Set(a).size).toBe(a.length);
  });

  it('is sensitive to the seed and to the commands', () => {
    const base = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
    const otherSeed = new Sim({ seed: DETERMINISM_SEED + 1, players: DETERMINISM_PLAYERS });
    expect(otherSeed.hash()).not.toBe(base.hash());

    const script = buildDeterminismScript(2000);
    const plain = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
    const withExtra = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
    for (const cmd of script) {
      plain.enqueue(cmd);
      withExtra.enqueue(cmd);
    }
    // A mining target far outside the script's range, so it can't be a no-op.
    withExtra.enqueue({ tick: 1000, playerId: 1, type: 'MineStart', x: 12_345, y: 0 });
    withExtra.enqueue({ tick: 1999, playerId: 1, type: 'MineStart', x: 12_345, y: 0 });
    for (let i = 0; i < 2000; i++) {
      plain.step();
      withExtra.step();
    }
    expect(withExtra.hash()).not.toBe(plain.hash());
  });

  it('does not depend on the enqueue order across players and ticks', () => {
    const script = buildDeterminismScript(3000);
    const sorted = script.slice().sort((a, b) => a.tick - b.tick || a.playerId - b.playerId);
    const run = (commands: typeof script): number => {
      const sim = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
      commands.forEach((c) => sim.enqueue(c));
      for (let i = 0; i < 3000; i++) {
        sim.step();
      }
      return sim.hash();
    };
    expect(run(sorted)).toBe(run(script));
  });
});
