import { describe, expect, it } from 'vitest';
import {
  LOW_POWER_REPEAT_TICKS,
  SoundEventDiffer,
  beltSources,
  craftFinished,
  machineSources,
  type AudioEntity,
  type AudioFrame,
} from '../../src/audio/events';
import { EntityTypeId, SAT_ONE } from '../../src/data/entities';
import { RECIPES, RecipeId } from '../../src/data/recipes';
import { TechId } from '../../src/data/technologies';
import { MachineState } from '../../src/sim/entities/machine';
import type { InserterData } from '../../src/sim/snapshot';

const WINDOW = { cx0: -1, cy0: -1, cx1: 1, cy1: 1 };

function frame(over: Partial<AudioFrame> = {}): AudioFrame {
  return {
    tick: 0,
    ticksRun: 1,
    chunkWindow: WINDOW,
    entities: [],
    inserters: [],
    player: null,
    craftQueue: { progress: 0, entries: [] },
    research: { current: 0, techs: new Map() },
    networks: [],
    ...over,
  };
}

const chest = (id: number, x: number, y: number): AudioEntity => ({
  id,
  type: EntityTypeId.WoodenChest,
  x,
  y,
  w: 1,
  h: 1,
  status: MachineState.Idle,
});

const inserter = (x: number, swing: number): InserterData => ({
  x,
  y: 0,
  dir: 0,
  arm: 0,
  held: 0,
  swing,
  span: 36,
  type: EntityTypeId.BurnerInserter,
});

const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

describe('SoundEventDiffer', () => {
  it('makes no sound on the first frame', () => {
    const d = new SoundEventDiffer();
    expect(d.next(frame({ entities: [chest(1, 0, 0)] }))).toEqual([]);
  });

  it('plays place and remove at the entity center inside the chunk window', () => {
    const d = new SoundEventDiffer();
    d.next(frame({ entities: [chest(1, 0, 0)] }));
    expect(d.next(frame({ tick: 1, entities: [chest(1, 0, 0), chest(2, 5, 6)] }))).toEqual([
      { kind: 'place', x: 5.5, y: 6.5 },
    ]);
    expect(d.next(frame({ tick: 2, entities: [chest(2, 5, 6)] }))).toEqual([
      { kind: 'remove', x: 0.5, y: 0.5 },
    ]);
  });

  it('stays silent for entities that scroll into or out of view', () => {
    const d = new SoundEventDiffer();
    d.next(
      frame({ chunkWindow: { cx0: 0, cy0: 0, cx1: 1, cy1: 1 }, entities: [chest(1, 10, 10)] }),
    );
    // The window moved one chunk west: chunk -1 is new, chunk 1 left.
    const events = d.next(
      frame({
        tick: 1,
        chunkWindow: { cx0: -1, cy0: 0, cx1: 0, cy1: 1 },
        entities: [chest(1, 10, 10), chest(2, -20, 10)],
      }),
    );
    expect(events).toEqual([]);
    expect(
      d.next(frame({ tick: 2, chunkWindow: { cx0: 1, cy0: 0, cx1: 2, cy1: 1 }, entities: [] })),
    ).toEqual([]);
  });

  it('plays the inserter whir when an arm starts towards its drop end', () => {
    const d = new SoundEventDiffer();
    d.next(frame({ inserters: [inserter(0, 0), inserter(3, -1), inserter(6, 1)] }));
    const events = d.next(
      frame({
        tick: 1,
        inserters: [inserter(0, 1), inserter(3, 1), inserter(6, 1), inserter(9, 1)],
      }),
    );
    // Not the one already swinging, nor the one that just came into view.
    expect(events).toEqual([
      { kind: 'inserter', x: 0.5, y: 0.5 },
      { kind: 'inserter', x: 3.5, y: 0.5 },
    ]);
  });

  it('plays pick strokes while hand-mining and a pop when a unit comes off', () => {
    const d = new SoundEventDiffer();
    const mining = (tick: number, mineProgress: number) =>
      frame({ tick, player: { mining: true, mineX: 4, mineY: 2, mineProgress } });
    d.next(frame({ player: { mining: false, mineX: 0, mineY: 0, mineProgress: 0 } }));
    expect(kinds(d.next(mining(1, 1)))).toEqual(['mine-hit']);
    expect(kinds(d.next(mining(2, 10)))).toEqual([]);
    expect(d.next(mining(3, 16))).toEqual([{ kind: 'mine-hit', x: 4.5, y: 2.5 }]);
    expect(kinds(d.next(mining(4, 29)))).toEqual([]);
    expect(kinds(d.next(mining(5, 0)))).toEqual(['mined']);
  });

  it('plays craft-done when a craft finishes, not when one is cancelled', () => {
    const ticks = RECIPES[RecipeId.IronGearWheel].ticks;
    const entry = (crafts: number) => ({ recipe: RecipeId.IronGearWheel, crafts, flags: 0 });
    const before = { progress: ticks - 1, entries: [entry(2)] };
    expect(craftFinished(before, { progress: 0, entries: [entry(1)] }, 1)).toBe(true);
    // Cancelled half way.
    expect(
      craftFinished({ progress: 5, entries: [entry(2)] }, { progress: 0, entries: [] }, 1),
    ).toBe(false);
    // Still going.
    expect(craftFinished(before, { progress: ticks - 1, entries: [entry(2)] }, 1)).toBe(false);

    const d = new SoundEventDiffer();
    d.next(frame({ craftQueue: before }));
    expect(
      kinds(d.next(frame({ tick: 1, craftQueue: { progress: 0, entries: [entry(1)] } }))),
    ).toEqual(['craft-done']);
  });

  it('plays research-complete once when a technology gets researched', () => {
    const d = new SoundEventDiffer();
    const research = (unitsDone: number) => ({
      current: TechId.Automation,
      techs: new Map([[TechId.Automation, { unitsDone, unitsInProgress: 0, ticksInProgress: 0 }]]),
    });
    d.next(frame({ research: research(9) }));
    expect(kinds(d.next(frame({ tick: 1, research: research(10) })))).toEqual([
      'research-complete',
    ]);
    expect(d.next(frame({ tick: 2, research: research(10) }))).toEqual([]);
  });

  it('warns about low power when it starts and again while it lasts', () => {
    const d = new SoundEventDiffer();
    const net = (satisfaction: number) => [
      { id: 1, poles: 1, demand: 100, supply: 50, satisfaction },
    ];
    d.next(frame({ networks: net(SAT_ONE) }));
    expect(kinds(d.next(frame({ tick: 1, networks: net(SAT_ONE / 2) })))).toEqual(['low-power']);
    expect(d.next(frame({ tick: 2, networks: net(SAT_ONE / 2) }))).toEqual([]);
    expect(
      kinds(d.next(frame({ tick: 1 + LOW_POWER_REPEAT_TICKS, networks: net(SAT_ONE / 2) }))),
    ).toEqual(['low-power']);
    // An idle network (no demand) isn't short.
    expect(
      d.next(
        frame({
          tick: 2000,
          networks: [{ id: 1, poles: 1, demand: 0, supply: 0, satisfaction: 0 }],
        }),
      ),
    ).toEqual([]);
  });

  it('starts over after reset', () => {
    const d = new SoundEventDiffer();
    d.next(frame());
    d.reset();
    expect(d.next(frame({ tick: 5, entities: [chest(1, 0, 0)] }))).toEqual([]);
  });
});

describe('loop sources', () => {
  it('lists working machines (low power included) by kind, at their centers', () => {
    const machine = (id: number, type: number, status: number): AudioEntity => ({
      id,
      type,
      x: 0,
      y: 0,
      w: 2,
      h: 2,
      status,
    });
    expect(
      machineSources([
        machine(1, EntityTypeId.StoneFurnace, MachineState.Working),
        machine(2, EntityTypeId.AssemblingMachine1, MachineState.LowPower),
        machine(3, EntityTypeId.ElectricMiningDrill, MachineState.NoPower),
        machine(4, EntityTypeId.WoodenChest, MachineState.Working),
        machine(5, EntityTypeId.Lab, MachineState.Working),
      ]),
    ).toEqual([
      { id: 1, kind: 'furnace', x: 1, y: 1 },
      { id: 2, kind: 'assembler', x: 1, y: 1 },
      { id: 5, kind: 'lab', x: 1, y: 1 },
    ]);
  });

  it('lists belts whose items moved, from the snapshot buffer', () => {
    // [count], then per belt [x, y, dir, shape, itemCount, type, mode] and [lane, offset, moved, item] per item.
    const T = EntityTypeId.TransportBelt;
    const buffer = new Int32Array([
      3,
      ...[0, 0, 0, 0, 2, T, 0, 0, 10, 0, 1, 1, 50, 2, 1], // the second item moved
      ...[1, 0, 0, 0, 1, T, 0, 0, 10, 0, 1], // stuck
      ...[2, 4, 0, 0, 0, T, 0], // empty
    ]).buffer;
    expect(beltSources(buffer)).toEqual([{ x: 0.5, y: 0.5 }]);
    expect(beltSources(new ArrayBuffer(0))).toEqual([]);
  });
});
