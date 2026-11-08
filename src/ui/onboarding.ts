/**
 * Onboarding for the first five minutes (#91): an objective tracker that
 * walks a new player through mine → craft → place a drill → belt → furnace
 * → inserter → chest → power (fuel), the GDD's "first automated drill →
 * furnace within 5 minutes".
 *
 * Every step advances on real game state as the main thread sees it in the
 * snapshots (inventory, crafting queue, the entities around the view and
 * their machine states), never on clicks in the tutorial itself. Progress is
 * UI state in `localStorage`, per browser and never in a save (D54): the
 * step conditions read the game, so a loaded game catches up on its own.
 *
 * This module is the pure part (steps, conditions, progress parsing),
 * unit-tested in Node; onboardingPanel.ts draws it.
 */

import {
  EntityTypeId,
  entityPrototype,
  inserterReach,
  isBeltType,
  isChestPrototype,
  isInserterPrototype,
  type EntityPrototype,
} from '../data/entities';
import { ItemId } from '../data/items';
import { RecipeId } from '../data/recipes';
import { ResourceId } from '../data/resources';
import type { Direction } from '../sim/entities/direction';
import { drillDropTileFor } from '../sim/entities/drill';
import { inserterDropTile, inserterPickupTile } from '../sim/entities/inserter';
import { MachineState } from '../sim/entities/machine';
import type { SlotData } from '../sim/snapshot';
import type { Action } from './keybindings';

/** Stone a stone furnace takes (its hand recipe). */
export const FURNACE_STONE = 5;

export type StepId =
  'mine' | 'craft' | 'drill' | 'belt' | 'furnace' | 'inserter' | 'chest' | 'power';

/** One objective. */
export interface StepInfo {
  id: StepId;
  /** Short name for the checklist. */
  title: string;
  /** What to do (keys are named by action and filled in with the current bindings). */
  text: string;
  /** Keys this step uses, shown as key caps. */
  keys: readonly Action[];
  /** The item to point out in the hotbar, if any. */
  item?: number;
  /** The hand recipe to point out in the crafting panel, if any. */
  recipe?: number;
  /** The starting ore patch to point the player to, if any. */
  patch?: number;
}

export const STEPS: readonly StepInfo[] = [
  {
    id: 'mine',
    title: 'Mine stone',
    text: `Walk to the stone patch and hold the right mouse button on it until you have ${String(FURNACE_STONE)} stone.`,
    keys: ['moveUp', 'moveLeft', 'moveDown', 'moveRight'],
    patch: ResourceId.Stone,
  },
  {
    id: 'craft',
    title: 'Craft a furnace',
    text: 'Open the inventory and click the stone furnace recipe to craft one from your stone.',
    keys: ['inventory'],
    recipe: RecipeId.StoneFurnace,
  },
  {
    id: 'drill',
    title: 'Place a drill',
    text: 'Select the burner mining drill and click to place it on iron ore. Rotate it so its output faces where the line goes.',
    keys: ['rotate'],
    item: ItemId.BurnerMiningDrill,
    patch: ResourceId.IronOre,
  },
  {
    id: 'belt',
    title: 'Lay a belt',
    text: "Place transport belts starting on the drill's output tile (the arrow); drag to lay a row.",
    keys: ['rotate'],
    item: ItemId.TransportBelt,
  },
  {
    id: 'furnace',
    title: 'Place a furnace',
    text: 'Place a stone furnace a tile past the end of the belt.',
    keys: [],
    item: ItemId.StoneFurnace,
  },
  {
    id: 'inserter',
    title: 'Feed the furnace',
    text: 'Place a burner inserter between the belt and the furnace, facing the furnace: it moves ore from the belt in.',
    keys: ['rotate'],
    item: ItemId.BurnerInserter,
  },
  {
    id: 'chest',
    title: 'Collect plates',
    text: 'Place a second inserter out of the other side of the furnace, and a wooden chest where it drops.',
    keys: ['rotate'],
    item: ItemId.WoodenChest,
  },
  {
    id: 'power',
    title: 'Power it',
    text: 'Burner machines run on coal: click the drill, the furnace and both inserters, and click the coal in the window to fuel each.',
    keys: [],
    item: ItemId.Coal,
  },
];

export const STEP_IDS: readonly StepId[] = STEPS.map((s) => s.id);

/** An entity as the tracker reads it (the renderer's `EntityView` fits). */
export interface OnboardingEntity {
  type: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dir: number;
  status: number;
}

/** The game state the steps read, from the latest snapshot. */
export interface OnboardingState {
  inventory: readonly SlotData[];
  /** Recipes in the hand-crafting queue. */
  craftQueue: readonly number[];
  /** Entities around the view. */
  entities: readonly OnboardingEntity[];
  /** The resource on tile `(x, y)`, or `null` where the renderer has no terrain. */
  resourceAt: (x: number, y: number) => number | null;
}

/** Stored progress: the current step (`STEPS.length` once done), and whether the player closed it. */
export interface OnboardingProgress {
  step: number;
  dismissed: boolean;
}

export const NEW_PROGRESS: OnboardingProgress = { step: 0, dismissed: false };

/** Progress from stored data (anything, e.g. parsed JSON); a fresh start for anything invalid. */
export function parseProgress(raw: unknown): OnboardingProgress {
  if (typeof raw !== 'object' || raw === null) return NEW_PROGRESS;
  const { step, dismissed } = raw as Record<string, unknown>;
  return {
    step:
      typeof step === 'number' && Number.isInteger(step) && step >= 0 && step <= STEPS.length
        ? step
        : 0,
    dismissed: dismissed === true,
  };
}

/** Whether the tracker shows with `progress`: not closed by the player. */
export function isActive(progress: OnboardingProgress): boolean {
  return !progress.dismissed;
}

function count(slots: readonly SlotData[], item: number): number {
  let n = 0;
  for (const s of slots) if (s.item === item) n += s.count;
  return n;
}

function protoOf(e: OnboardingEntity): EntityPrototype | undefined {
  return entityPrototype(e.type);
}

const isDrill = (e: OnboardingEntity): boolean =>
  e.type === EntityTypeId.BurnerMiningDrill || e.type === EntityTypeId.ElectricMiningDrill;
const isFurnace = (e: OnboardingEntity): boolean => e.type === EntityTypeId.StoneFurnace;
const isInserter = (e: OnboardingEntity): boolean => isInserterPrototype(protoOf(e));

/** Whether drill `d` stands on iron ore (any tile of it; `true` where the terrain isn't known). */
function onIron(d: OnboardingEntity, state: OnboardingState): boolean {
  let unknown = false;
  for (let y = d.y; y < d.y + d.h; y++) {
    for (let x = d.x; x < d.x + d.w; x++) {
      const r = state.resourceAt(x, y);
      if (r === ResourceId.IronOre) return true;
      if (r === null) unknown = true;
    }
  }
  return unknown;
}

/** Per state: the entities by tile they cover (built once, on the first lookup). */
const tileMaps = new WeakMap<readonly OnboardingEntity[], Map<string, OnboardingEntity>>();

/** The entity covering tile `(x, y)` that `pick` accepts, if any. */
function find(
  entities: readonly OnboardingEntity[],
  x: number,
  y: number,
  pick: (e: OnboardingEntity) => boolean,
): OnboardingEntity | undefined {
  let map = tileMaps.get(entities);
  if (!map) {
    map = new Map();
    for (const e of entities) {
      for (let ty = e.y; ty < e.y + e.h; ty++) {
        for (let tx = e.x; tx < e.x + e.w; tx++) map.set(`${String(tx)},${String(ty)}`, e);
      }
    }
    tileMaps.set(entities, map);
  }
  const e = map.get(`${String(x)},${String(y)}`);
  return e && pick(e) ? e : undefined;
}

/** Inserters with the tiles they pick up from and drop onto. */
function inserterEnds(entities: readonly OnboardingEntity[]) {
  return entities.filter(isInserter).map((e) => {
    const reach = inserterReach(protoOf(e)!);
    const dir = e.dir as Direction;
    return {
      e,
      pickup: inserterPickupTile(e.x, e.y, dir, reach),
      drop: inserterDropTile(e.x, e.y, dir, reach),
    };
  });
}

/** Inserters moving furnace output into a chest. */
function outputInserters(entities: readonly OnboardingEntity[]): OnboardingEntity[] {
  return inserterEnds(entities)
    .filter(
      ({ pickup, drop }) =>
        find(entities, pickup.x, pickup.y, isFurnace) &&
        find(entities, drop.x, drop.y, (c) => isChestPrototype(protoOf(c))),
    )
    .map(({ e }) => e);
}

/**
 * Whether the state-based step `id` (drill onwards) holds in `state`.
 * Mining and crafting depend on what happened, not only on what is there:
 * `OnboardingTracker` checks those.
 */
export function holds(id: StepId, state: OnboardingState): boolean {
  const { entities } = state;
  switch (id) {
    case 'mine':
      return count(state.inventory, ItemId.Stone) >= FURNACE_STONE;
    case 'craft':
      return state.craftQueue.includes(RecipeId.StoneFurnace);
    case 'drill':
      return entities.some((e) => isDrill(e) && onIron(e, state));
    case 'belt':
      return entities.some((d) => {
        if (!isDrill(d)) return false;
        const drop = drillDropTileFor(protoOf(d)!, d.x, d.y, d.dir as Direction);
        return find(entities, drop.x, drop.y, (b) => isBeltType(b.type)) !== undefined;
      });
    case 'furnace':
      return entities.some(isFurnace);
    case 'inserter':
      return inserterEnds(entities).some(
        ({ drop }) => find(entities, drop.x, drop.y, isFurnace) !== undefined,
      );
    case 'chest':
      return outputInserters(entities).length > 0;
    case 'power':
      // The line runs: an inserter is moving a plate out of a furnace into a chest.
      return outputInserters(entities).some((e) => e.status === MachineState.Working);
  }
}

/** Machines (drills, furnaces, inserters) around the view still waiting for fuel. */
export function unfuelled(state: OnboardingState): number {
  return state.entities.filter(
    (e) => (isDrill(e) || isFurnace(e) || isInserter(e)) && e.status === MachineState.NoFuel,
  ).length;
}

/** The first state-based step: from here on every step reads only what is on the map. */
const FIRST_BUILD_STEP = STEP_IDS.indexOf('drill');

/**
 * Tracks the current step through snapshots. A step is done once its
 * condition holds while it is the current step; several can finish on one
 * snapshot. When the map already has what the build steps ask for (a
 * loaded game), the tracker skips ahead to the first build step it lacks.
 */
export class OnboardingTracker {
  /** Stone furnaces in the inventory when the craft step began (`null`: not seen yet). */
  private furnaces: number | null = null;

  constructor(public progress: OnboardingProgress) {}

  get step(): number {
    return this.progress.step;
  }

  get done(): boolean {
    return this.progress.step >= STEPS.length;
  }

  /** Advances on `state`; returns whether the step changed. */
  update(state: OnboardingState): boolean {
    const before = this.progress.step;
    let step = before;
    // A loaded game: skip what the map shows was built already.
    let built = FIRST_BUILD_STEP;
    while (built < STEPS.length && holds(STEP_IDS[built]!, state)) built++;
    if (built > FIRST_BUILD_STEP && step < built) step = built;
    while (step < STEPS.length && this.met(STEP_IDS[step]!, state)) step++;
    if (STEP_IDS[step] !== 'craft') this.furnaces = null;
    if (step === before) return false;
    this.progress = { ...this.progress, step };
    return true;
  }

  private met(id: StepId, state: OnboardingState): boolean {
    if (id !== 'craft') return holds(id, state);
    // Crafting: a furnace in the queue, or more furnaces than when the step began.
    const furnaces = count(state.inventory, ItemId.StoneFurnace);
    this.furnaces ??= furnaces;
    return holds('craft', state) || furnaces > this.furnaces;
  }
}

/** Compass direction and distance from `(fromX, fromY)` to `(toX, toY)` (tiles), e.g. `14 tiles north-east`. */
export function directionText(fromX: number, fromY: number, toX: number, toY: number): string {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.round(Math.hypot(dx, dy));
  if (dist <= 3) return 'right here';
  // Screen y grows southwards; 8 sectors of 45°, starting east.
  const names = [
    'east',
    'south-east',
    'south',
    'south-west',
    'west',
    'north-west',
    'north',
    'north-east',
  ];
  const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return `${String(dist)} tiles ${names[(sector + 8) % 8]!}`;
}
