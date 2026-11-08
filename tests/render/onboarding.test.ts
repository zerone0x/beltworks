import { describe, expect, it } from 'vitest';
import { EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { RecipeId } from '../../src/data/recipes';
import { ResourceId } from '../../src/data/resources';
import { Direction } from '../../src/sim/entities/direction';
import { drillDropTile } from '../../src/sim/entities/drill';
import { MachineState } from '../../src/sim/entities/machine';
import {
  NEW_PROGRESS,
  OnboardingTracker,
  STEPS,
  STEP_IDS,
  directionText,
  holds,
  parseProgress,
  unfuelled,
  type OnboardingEntity,
  type OnboardingState,
} from '../../src/ui/onboarding';
import { MAX_SEED, parseSeed } from '../../src/ui/seed';

const E = Direction.East;
const entity = (
  type: number,
  x: number,
  y: number,
  size = 1,
  status: number = MachineState.Idle,
): OnboardingEntity => ({ type, x, y, w: size, h: size, dir: E, status });

/** The M1 line facing east on row 0: drill on (0, 0), belts, inserter, furnace, inserter, chest. */
function line(status: Partial<Record<'put', number>> = {}): OnboardingEntity[] {
  const drop = drillDropTile(0, 0, E); // (2, 0)
  return [
    entity(EntityTypeId.BurnerMiningDrill, 0, 0, 2),
    entity(EntityTypeId.TransportBelt, drop.x, drop.y),
    entity(EntityTypeId.TransportBelt, drop.x + 1, drop.y),
    entity(EntityTypeId.BurnerInserter, drop.x + 2, drop.y),
    entity(EntityTypeId.StoneFurnace, drop.x + 3, drop.y, 2),
    entity(EntityTypeId.BurnerInserter, drop.x + 5, drop.y, 1, status.put ?? MachineState.Idle),
    entity(EntityTypeId.WoodenChest, drop.x + 6, drop.y),
  ];
}

function state(partial: Partial<OnboardingState> = {}): OnboardingState {
  return {
    inventory: [],
    craftQueue: [],
    entities: [],
    // Iron ore under the drill's tiles, nothing elsewhere.
    resourceAt: (x, y) => (x >= 0 && x < 2 && y >= 0 && y < 2 ? ResourceId.IronOre : 0),
    ...partial,
  };
}

describe('onboarding steps', () => {
  it('teach the first five minutes in order', () => {
    expect(STEP_IDS).toEqual([
      'mine',
      'craft',
      'drill',
      'belt',
      'furnace',
      'inserter',
      'chest',
      'power',
    ]);
    for (const step of STEPS) expect(step.text.length).toBeGreaterThan(20);
  });

  it('read the map: each build step holds once its part of the line stands', () => {
    const full = line();
    // Build the line part by part, in the order of the steps.
    const parts: [string, number][] = [
      ['drill', 1],
      ['belt', 2],
      ['furnace', 5],
      ['inserter', 5],
      ['chest', 7],
    ];
    for (const [id, count] of parts) {
      const order = [0, 1, 2, 4, 3, 5, 6];
      const built = order.slice(0, count).map((i) => full[i]!);
      expect(holds(id as never, state({ entities: built })), id).toBe(true);
    }
    expect(holds('inserter', state({ entities: [full[0]!, full[1]!, full[4]!] }))).toBe(false);
    expect(holds('chest', state({ entities: full.slice(0, 6) }))).toBe(false);
  });

  it('want the drill on iron ore', () => {
    const drill = entity(EntityTypeId.BurnerMiningDrill, 10, 10, 2);
    expect(holds('drill', state({ entities: [drill] }))).toBe(false);
    // Unknown terrain (not streamed yet) doesn't hold the player back.
    expect(holds('drill', state({ entities: [drill], resourceAt: () => null }))).toBe(true);
  });

  it('finish with power once the output inserter moves plates', () => {
    expect(holds('power', state({ entities: line() }))).toBe(false);
    expect(holds('power', state({ entities: line({ put: MachineState.NoFuel }) }))).toBe(false);
    expect(holds('power', state({ entities: line({ put: MachineState.Working }) }))).toBe(true);
    expect(unfuelled(state({ entities: line({ put: MachineState.NoFuel }) }))).toBe(1);
  });
});

describe('onboarding tracker', () => {
  it('advances through mining and crafting on inventory and queue changes', () => {
    const t = new OnboardingTracker(NEW_PROGRESS);
    expect(t.update(state({ inventory: [{ item: ItemId.Stone, count: 3 }] }))).toBe(false);
    expect(t.step).toBe(0);
    const stone = { item: ItemId.Stone, count: 5 };
    const furnaces = { item: ItemId.StoneFurnace, count: 2 };
    expect(t.update(state({ inventory: [stone, furnaces] }))).toBe(true);
    expect(STEP_IDS[t.step]).toBe('craft');
    // The furnace comes out of the queue: more furnaces than when the step began.
    expect(t.update(state({ inventory: [{ item: ItemId.StoneFurnace, count: 3 }] }))).toBe(true);
    expect(STEP_IDS[t.step]).toBe('drill');
  });

  it('counts a queued furnace as crafting', () => {
    const t = new OnboardingTracker({ step: 1, dismissed: false });
    t.update(state());
    t.update(state({ craftQueue: [RecipeId.StoneFurnace] }));
    expect(STEP_IDS[t.step]).toBe('drill');
  });

  it('runs to the end as the line is built and powered', () => {
    const t = new OnboardingTracker({ step: 2, dismissed: false });
    t.update(state({ entities: line() }));
    expect(STEP_IDS[t.step]).toBe('power');
    t.update(state({ entities: line({ put: MachineState.Working }) }));
    expect(t.done).toBe(true);
  });

  it('skips ahead in a loaded game that has the line already', () => {
    const t = new OnboardingTracker(NEW_PROGRESS);
    t.update(state({ entities: line() }));
    expect(STEP_IDS[t.step]).toBe('power');
  });

  it('parses stored progress, falling back to a fresh start', () => {
    expect(parseProgress(null)).toEqual(NEW_PROGRESS);
    expect(parseProgress({ step: 3, dismissed: true })).toEqual({ step: 3, dismissed: true });
    expect(parseProgress({ step: 99 })).toEqual(NEW_PROGRESS);
    expect(parseProgress({ step: STEPS.length })).toEqual({ step: STEPS.length, dismissed: false });
    expect(parseProgress({ step: 1.5, dismissed: 'yes' })).toEqual(NEW_PROGRESS);
  });

  it('points the way to a patch', () => {
    expect(directionText(0, 0, 1, 1)).toBe('right here');
    expect(directionText(0, 0, 20, 0)).toBe('20 tiles east');
    expect(directionText(0, 0, -10, -10)).toBe('14 tiles north-west');
    expect(directionText(0, 0, 0, 12)).toBe('12 tiles south');
  });
});

describe('world seeds', () => {
  it('take numbers as they are and hash any other text', () => {
    expect(parseSeed(' 42 ')).toBe(42);
    expect(parseSeed(String(MAX_SEED))).toBe(MAX_SEED);
    expect(parseSeed('')).toBeNull();
    const word = parseSeed('factory');
    expect(word).toBe(parseSeed('factory'));
    expect(word).not.toBe(parseSeed('Factory'));
    expect(Number.isInteger(word) && word! >= 0 && word! <= MAX_SEED).toBe(true);
    // Too large for a uint32: hashed like text, never wrapped.
    expect(parseSeed('4294967296')).not.toBe(0);
  });
});
