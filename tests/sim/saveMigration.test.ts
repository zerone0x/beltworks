import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { gunzip, gzip } from '../../src/save/compress';
import { ChestTable } from '../../src/sim/entities/chest';
import { createEntityTables } from '../../src/sim/entities/registry';
import { SaveReader, SaveWriter } from '../../src/sim/save/codec';
import { MIGRATIONS, type Migration } from '../../src/sim/save/migrations';
import { SAVE_VERSION, loadSim, readSaveMeta, saveSim } from '../../src/sim/save/save';
import { buildDeterminismScript, createDeterminismSim } from '../../src/sim/scenarios/determinism';
import { STATE_HASH_VERSION } from '../../src/sim/state';
import { expectRoundTrip } from './saveRoundTrip';

/**
 * Saves made by earlier builds, one per save format: each must keep loading
 * (through the migrations) in every later build. Add one whenever
 * `SAVE_VERSION` goes up: `WRITE_SAVE_FIXTURE=1 npx vitest run tests/sim/saveMigration.test.ts`
 * writes the current format's fixture if it doesn't exist yet.
 */
const FIXTURES = new URL('../fixtures/saves/', import.meta.url);
const FIXTURE_TICK = 2_000;

/** What a fixture's sidecar JSON records about it, when it was made. */
interface FixtureInfo {
  version: number;
  tick: number;
  entities: number;
  /** State hash right after loading, valid while the hashed layout is `stateHashVersion`. */
  hash: number;
  stateHashVersion: number;
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURES).filter((f) => f.endsWith('.bwsave'));
}

async function readFixture(name: string): Promise<Uint8Array> {
  return gunzip(new Uint8Array(readFileSync(new URL(name, FIXTURES))));
}

describe('save fixtures from earlier formats', () => {
  it('has one for the current format', () => {
    expect(fixtureNames()).toContain(`v${String(SAVE_VERSION)}-determinism.bwsave`);
  });

  for (const name of fixtureNames()) {
    it(`${name} loads, matches what it recorded and runs on`, async () => {
      const bytes = await readFixture(name);
      const info = JSON.parse(
        readFileSync(new URL(name.replace(/\.bwsave$/, '.json'), FIXTURES), 'utf8'),
      ) as FixtureInfo;
      expect(readSaveMeta(bytes).version).toBe(info.version);
      const sim = loadSim(bytes);
      expect(sim.tick).toBe(info.tick);
      expect(sim.state.entities.count).toBe(info.entities);
      if (info.stateHashVersion === STATE_HASH_VERSION && info.version === SAVE_VERSION) {
        expect(sim.hash()).toBe(info.hash);
      }
      for (let i = 0; i < 600; i++) sim.step();
      expectRoundTrip(sim, 60);
    });
  }

  it.runIf(process.env.WRITE_SAVE_FIXTURE)('writes the current format’s fixture', async () => {
    const name = `v${String(SAVE_VERSION)}-determinism`;
    if (fixtureNames().includes(`${name}.bwsave`)) return;
    const sim = createDeterminismSim();
    for (const cmd of buildDeterminismScript()) sim.enqueue(cmd);
    for (let i = 0; i < FIXTURE_TICK; i++) sim.step();
    writeFileSync(new URL(`${name}.bwsave`, FIXTURES), await gzip(saveSim(sim)));
    const info: FixtureInfo = {
      version: SAVE_VERSION,
      tick: sim.tick,
      entities: sim.state.entities.count,
      hash: sim.hash(),
      stateHashVersion: STATE_HASH_VERSION,
    };
    writeFileSync(new URL(`${name}.json`, FIXTURES), `${JSON.stringify(info, null, 2)}\n`);
  });
});

/**
 * A wooden chest table of a pretend next format, which saves one more
 * column: a per-chest limit (0: none).
 */
class LimitedChestTable extends ChestTable {
  limits = new Uint16Array(0);

  override save(w: SaveWriter): void {
    super.save(w);
    w.column(this.limits, this.count);
  }

  override load(r: SaveReader): void {
    super.load(r);
    this.limits = r.column(this.limits, this.count);
  }
}

/** The migration to that format: every chest gets the limit 0. */
const ADD_CHEST_LIMITS: Migration = {
  from: SAVE_VERSION,
  describe: 'wooden chests get a limit',
  migrate(doc) {
    const name = 'table:wooden-chest';
    const old = doc.sections.get(name)!;
    const r = new SaveReader(old, name);
    r.u32(); // slots per chest
    const rows = r.column(new Uint32Array(0)).length;
    const w = new SaveWriter();
    w.raw(old);
    w.column(new Uint16Array(rows));
    doc.sections.set(name, w.bytes());
  },
};

function tablesWithLimits() {
  return createEntityTables().map((t) =>
    t.type === EntityTypeId.WoodenChest ? new LimitedChestTable(ENTITIES[t.type]) : t,
  );
}

describe('save migrations', () => {
  it('migrates the current format’s fixture through a simulated schema bump', async () => {
    const bytes = await readFixture(`v${String(SAVE_VERSION)}-determinism.bwsave`);
    const reference = loadSim(bytes);
    let chests: LimitedChestTable | undefined;
    const sim = loadSim(bytes, {
      version: SAVE_VERSION + 1,
      migrations: [...MIGRATIONS, ADD_CHEST_LIMITS],
      entityTables: () => {
        const tables = tablesWithLimits();
        chests = tables.find((t) => t instanceof LimitedChestTable);
        return tables;
      },
    });
    expect(chests!.count).toBeGreaterThan(0);
    expect(Array.from(chests!.limits)).toEqual(new Array<number>(chests!.count).fill(0));
    // Everything else came through unchanged, and the game runs on as before.
    expect(sim.hash()).toBe(reference.hash());
    for (let i = 0; i < 300; i++) {
      sim.step();
      reference.step();
    }
    expect(sim.hash()).toBe(reference.hash());
  });

  it('refuses an older format it has no migration for', async () => {
    const bytes = await readFixture(`v${String(SAVE_VERSION)}-determinism.bwsave`);
    expect(() =>
      loadSim(bytes, { version: SAVE_VERSION + 1, entityTables: tablesWithLimits }),
    ).toThrow(`No migration from save format ${String(SAVE_VERSION)}`);
  });
});
