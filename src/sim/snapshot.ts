/**
 * Render snapshot encoding: copies the state the renderer needs into fresh
 * typed arrays whose buffers can be transferred to the main thread.
 */

import { SAT_ONE } from '../data/entities';
import { RECIPE_IDS } from '../data/recipes';
import { TECH_IDS, recipeUnlockedBy, technologyPrototype } from '../data/technologies';
import { beltTable } from './belts/belts';
import { CRAFT_QUEUE_LENGTH } from './crafting/queue';
import { reaches } from './entities/build';
import { inserterTableOf } from './entities/inserter';
import { MachineState } from './entities/machine';
import type { ChunkRange } from './entities/occupancy';
import { powerGrid } from './power/grid';
import { poweredEnergy } from './power/solver';
import { labTable } from './research/lab';
import { forceOf, isRecipeUnlocked } from './research/unlocks';
import type { SimState } from './state';
import { CHUNK_AREA } from './world/chunk';

/** Int32 fields per player in {@link encodePlayers}. */
export const PLAYER_STRIDE = 6;
/** Field offsets within one player record. */
export const PlayerField = {
  x: 0,
  y: 1,
  mining: 2,
  mineX: 3,
  mineY: 4,
  mineProgress: 5,
} as const;

/**
 * Encodes every player as `PLAYER_STRIDE` int32s:
 * `[x, y, mining, mineX, mineY, mineProgress]` (positions in subtiles, mine
 * target in tiles, progress in ticks out of `HAND_MINING_TICKS`).
 */
export function encodePlayers(state: SimState): Int32Array<ArrayBuffer> {
  const p = state.players;
  const out = new Int32Array(p.count * PLAYER_STRIDE);
  for (let i = 0, o = 0; i < p.count; i++, o += PLAYER_STRIDE) {
    out[o + PlayerField.x] = p.x[i]!;
    out[o + PlayerField.y] = p.y[i]!;
    out[o + PlayerField.mining] = p.mining[i]!;
    out[o + PlayerField.mineX] = p.mineX[i]!;
    out[o + PlayerField.mineY] = p.mineY[i]!;
    out[o + PlayerField.mineProgress] = p.mineProgress[i]!;
  }
  return out;
}

/**
 * Encodes player `playerId`'s inventory as uint16 pairs `[item, count]`, one
 * per slot (`PLAYER_INVENTORY_SLOTS` slots).
 */
export function encodeInventory(state: SimState, playerId: number): Uint16Array<ArrayBuffer> {
  const inv = state.players.inventory(playerId);
  const out = new Uint16Array(inv.slots * 2);
  for (let i = 0; i < inv.slots; i++) {
    out[2 * i] = inv.items[i]!;
    out[2 * i + 1] = inv.counts[i]!;
  }
  return out;
}

/** Uint16 fields per queue entry in {@link encodeCraftQueue}, after the 2-field header. */
export const CRAFT_ENTRY_STRIDE = 3;

/**
 * Encodes player `playerId`'s crafting queue as uint16s:
 * `[progress, length, then per entry: recipe, crafts, flags]`, front first
 * (progress in ticks into the front entry's current craft; flags as in
 * `CraftFlag`).
 */
export function encodeCraftQueue(state: SimState, playerId: number): Uint16Array<ArrayBuffer> {
  const q = state.crafting;
  const len = q.size(playerId);
  const out = new Uint16Array(2 + len * CRAFT_ENTRY_STRIDE);
  out[0] = q.progress[playerId]!;
  out[1] = len;
  const base = playerId * CRAFT_QUEUE_LENGTH;
  for (let i = 0; i < len; i++) {
    const o = 2 + i * CRAFT_ENTRY_STRIDE;
    out[o] = q.recipe[base + i]!;
    out[o + 1] = q.crafts[base + i]!;
    out[o + 2] = q.flags[base + i]!;
  }
  return out;
}

/** A crafting queue as decoded on the main thread. */
export interface CraftQueueData {
  /** Ticks into the front entry's current craft. */
  progress: number;
  entries: { recipe: number; crafts: number; flags: number }[];
}

/** Unpacks a buffer made by {@link encodeCraftQueue}. */
export function decodeCraftQueue(buffer: ArrayBuffer): CraftQueueData {
  const view = new Uint16Array(buffer, 0, buffer.byteLength >> 1);
  const len = Math.min(view[1] ?? 0, Math.floor((view.length - 2) / CRAFT_ENTRY_STRIDE));
  const entries: CraftQueueData['entries'] = [];
  for (let i = 0; i < len; i++) {
    const o = 2 + i * CRAFT_ENTRY_STRIDE;
    entries.push({ recipe: view[o]!, crafts: view[o + 1]!, flags: view[o + 2]! });
  }
  return { progress: view[0] ?? 0, entries };
}

/**
 * The machine state the renderer and GUI show for entity `id`: its own
 * state, except that a `Working` electric consumer on a network whose
 * satisfaction is below 1 shows `LowPower` (it works, but slower).
 */
export function displayStatus(state: SimState, id: number): MachineState {
  const { entities } = state;
  const status = entities.status(id);
  if (status !== MachineState.Working) return status;
  if (entities.table(entities.store.type(id))?.powerDemand === undefined) return status;
  const grid = powerGrid(entities);
  if (!grid || grid.networkOf(id) === 0) return status;
  return grid.satisfaction(id) < SAT_ONE ? MachineState.LowPower : status;
}

/**
 * Joules electric consumer `id` drew on the latest tick: its demand times
 * its network's satisfaction (`poweredEnergy`); 0 for anything else.
 */
function consumerDraw(state: SimState, id: number): number {
  const { entities } = state;
  if (entities.table(entities.store.type(id))?.powerDemand === undefined) return 0;
  const grid = powerGrid(entities);
  const member = grid?.member(id);
  if (!grid || !member || member.network === 0) return 0;
  return poweredEnergy(member.demand, grid.satisfaction(id));
}

/** Int32 fields per entity in {@link encodeEntities}. */
export const ENTITY_STRIDE = 7;
/** Field offsets within one entity record. */
export const EntityField = {
  id: 0,
  type: 1,
  x: 2,
  y: 3,
  dir: 4,
  status: 5,
  /** The recipe an assembling machine is set to (0 for none and for other types). */
  recipe: 6,
} as const;

/**
 * Encodes the entities whose origin (top-left tile) lies in the chunks of
 * `range` as `ENTITY_STRIDE` int32s each: `[id, type, x, y, dir, status,
 * recipe]` (ids are uint32s stored bit for bit; `x`, `y` is the top-left
 * tile; status is a `MachineState`, so the renderer can show working
 * machines; recipe the one an assembling machine is set to, so it can show
 * its product). Entities are
 * at most `MAX_ENTITY_SIZE` tiles wide, so a range with a one-chunk margin
 * around the viewport catches every entity that overlaps it.
 */
export function encodeEntities(state: SimState, range: ChunkRange | null): Int32Array<ArrayBuffer> {
  if (range === null) {
    return new Int32Array(0);
  }
  const { entities } = state;
  const { store, occupancy } = entities;
  const ids = occupancy.originsIn(range);
  const out = new Int32Array(ids.length * ENTITY_STRIDE);
  ids.forEach((id, i) => {
    const o = i * ENTITY_STRIDE;
    out[o + EntityField.id] = id;
    out[o + EntityField.type] = store.type(id);
    out[o + EntityField.x] = store.x(id);
    out[o + EntityField.y] = store.y(id);
    out[o + EntityField.dir] = store.dir(id);
    out[o + EntityField.status] = displayStatus(state, id);
    out[o + EntityField.recipe] = entities.selectedRecipe(id);
  });
  return out;
}

/** Int32 fields per belt record in {@link encodeBelts}, before its items. */
export const BELT_RECORD_HEADER = 7;
/** Int32 fields per item in {@link encodeBelts}. */
export const BELT_ITEM_STRIDE = 4;

/**
 * Encodes the belts (every tier, underground belts included) whose tile lies
 * in the chunks of `range`, with the items on them, as int32s:
 * `[beltCount]`, then per belt `[x, y, dir, shape, itemCount, type, mode]`
 * followed by `itemCount` records `[lane, offset, moved, item]` (`shape` a
 * `BeltShape`; `type` the entity type, whose `beltSpeed` is its tier;
 * `mode` an `UndergroundMode`; `offset` the item's distance from the belt's
 * end edge in subtiles, 0..256; `moved` how far it moved on the last tick,
 * for drawing it between ticks). Items under the ground between an
 * underground pair are on no belt and not sent. Belts come in the order of
 * `encodeEntities`.
 */
export function encodeBelts(state: SimState, range: ChunkRange | null): Int32Array<ArrayBuffer> {
  const table = beltTable(state.entities);
  if (range === null || !table) {
    return new Int32Array(1);
  }
  const { store, occupancy } = state.entities;
  const ids = occupancy.originsIn(range).filter((id) => table.isBelt(id));
  // Walk each line once, picking out the items on the belts in range.
  const items = new Map<number, number[]>();
  const wanted = new Map<number, Map<number, number[]>>();
  for (const id of ids) {
    const list: number[] = [];
    items.set(id, list);
    const line = table.beltLine(id);
    let byIndex = wanted.get(line);
    if (!byIndex) wanted.set(line, (byIndex = new Map<number, number[]>()));
    byIndex.set(table.beltIndex(id), list);
  }
  for (const [lineId, byIndex] of wanted) {
    table.forEachItem(table.line(lineId)!, (k, lane, offset, moved, item) => {
      byIndex.get(k)?.push(lane, offset, moved, item);
    });
  }
  const out: number[] = [ids.length];
  for (const id of ids) {
    const list = items.get(id)!;
    out.push(
      store.x(id),
      store.y(id),
      store.dir(id),
      table.shape(id),
      list.length / BELT_ITEM_STRIDE,
      store.type(id),
      table.mode(id),
    );
    for (const v of list) out.push(v);
  }
  return Int32Array.from(out);
}

/** A belt and its items as decoded on the main thread. */
export interface BeltData {
  x: number;
  y: number;
  dir: number;
  shape: number;
  /** Entity type (its prototype's `beltSpeed` is the tier). */
  type: number;
  /** `UndergroundMode` (`None` for transport belts). */
  mode: number;
  items: { lane: number; offset: number; moved: number; item: number }[];
}

/** Unpacks a buffer made by {@link encodeBelts}. */
export function decodeBelts(buffer: ArrayBuffer): BeltData[] {
  const v = new Int32Array(buffer);
  const out: BeltData[] = [];
  let o = 1;
  const count = v[0] ?? 0;
  for (let b = 0; b < count && o + BELT_RECORD_HEADER <= v.length; b++) {
    const n = v[o + 4]!;
    const belt: BeltData = {
      x: v[o]!,
      y: v[o + 1]!,
      dir: v[o + 2]!,
      shape: v[o + 3]!,
      type: v[o + 5]!,
      mode: v[o + 6]!,
      items: [],
    };
    o += BELT_RECORD_HEADER;
    for (let i = 0; i < n && o + BELT_ITEM_STRIDE <= v.length; i++, o += BELT_ITEM_STRIDE) {
      belt.items.push({ lane: v[o]!, offset: v[o + 1]!, moved: v[o + 2]!, item: v[o + 3]! });
    }
    out.push(belt);
  }
  return out;
}

/** Int32 fields per inserter in {@link encodeInserters}, after the count. */
export const INSERTER_STRIDE = 8;
/** Field offsets within one inserter record. */
export const InserterField = {
  x: 0,
  y: 1,
  dir: 2,
  /**
   * Arm position from the pickup end (0) to the drop end (`span`), in the
   * inserter type's arm units: ticks for burner inserters, 1/`SAT_ONE` ticks
   * for electric ones.
   */
  arm: 3,
  /** The item in the hand, or 0. */
  held: 4,
  /**
   * How the arm moved on the last tick, in arm units: positive towards the
   * drop end (+1 for a burner inserter), negative back, 0 not at all.
   */
  swing: 5,
  /** Arm position at the drop end (36 for burner inserters, 26 × `SAT_ONE` for electric). */
  span: 6,
  /** Entity type id (for the arm's length and color). */
  type: 7,
} as const;

/**
 * Encodes the inserters (every inserter type) whose tile lies in the chunks
 * of `range` as int32s: `[count]`, then `INSERTER_STRIDE` fields per inserter
 * (see {@link InserterField}), in the order of `encodeEntities`. The
 * renderer draws the arm `swing × (1 − α)` behind `arm` between ticks.
 */
export function encodeInserters(
  state: SimState,
  range: ChunkRange | null,
): Int32Array<ArrayBuffer> {
  if (range === null) {
    return new Int32Array(1);
  }
  const { entities } = state;
  const { store, occupancy } = entities;
  const ids = occupancy
    .originsIn(range)
    .filter((id) => inserterTableOf(entities, store.type(id)) !== undefined);
  const out = new Int32Array(1 + ids.length * INSERTER_STRIDE);
  out[0] = ids.length;
  ids.forEach((id, i) => {
    const o = 1 + i * INSERTER_STRIDE;
    const type = store.type(id);
    const table = inserterTableOf(entities, type)!;
    const { held, arm } = table.hand(id);
    out[o + InserterField.x] = store.x(id);
    out[o + InserterField.y] = store.y(id);
    out[o + InserterField.dir] = store.dir(id);
    out[o + InserterField.arm] = arm;
    out[o + InserterField.held] = held;
    out[o + InserterField.swing] = table.lastSwing(id, entities);
    out[o + InserterField.span] = table.armEnd;
    out[o + InserterField.type] = type;
  });
  return out;
}

/** An inserter as decoded on the main thread. */
export interface InserterData {
  x: number;
  y: number;
  dir: number;
  arm: number;
  held: number;
  swing: number;
  span: number;
  type: number;
}

/** Unpacks a buffer made by {@link encodeInserters}. */
export function decodeInserters(buffer: ArrayBuffer): InserterData[] {
  const v = new Int32Array(buffer);
  const count = Math.min(v[0] ?? 0, Math.floor((v.length - 1) / INSERTER_STRIDE));
  const out: InserterData[] = [];
  for (let i = 0; i < count; i++) {
    const o = 1 + i * INSERTER_STRIDE;
    out.push({
      x: v[o + InserterField.x]!,
      y: v[o + InserterField.y]!,
      dir: v[o + InserterField.dir]!,
      arm: v[o + InserterField.arm]!,
      held: v[o + InserterField.held]!,
      swing: v[o + InserterField.swing]!,
      span: v[o + InserterField.span]!,
      type: v[o + InserterField.type]!,
    });
  }
  return out;
}

/** Int32 fields per pole in {@link encodePower}. */
export const POLE_STRIDE = 5;
/** Int32 fields per network in {@link encodePower}. */
export const NETWORK_STRIDE = 5;
/** Int32 fields per electric entity in {@link encodePower}. */
export const MEMBER_STRIDE = 5;

/**
 * Encodes the electric grid around the view as int32s, in four sections:
 * - `[poleCount]`, then per pole whose tile lies in the chunks of `range`
 *   (in the order of `encodeEntities`) `[id, type, x, y, network]`;
 * - `[wireCount]`, then per wire between two of those poles `[a, b]` (pole
 *   ids, `a < b`, in pole order). Wires to poles outside the range are left
 *   out: wires are at most 7 tiles long and the range has a one-chunk margin
 *   around the viewport, so none of them would show;
 * - `[networkCount]`, then per network of those poles (ascending ids) `[id,
 *   poles, demand, supply, satisfaction]` as of the latest tick (joules are
 *   uint32s stored bit for bit);
 * - `[memberCount]`, then per electric entity (consumer or producer) whose
 *   origin lies in the chunks of `range`, in the order of `encodeEntities`,
 *   `[id, network, demand, maxOutput, drawn]` as of the latest tick (see
 *   `MemberStats`; network 0 when not connected). Steam engines animate
 *   with what they delivered.
 */
export function encodePower(state: SimState, range: ChunkRange | null): Int32Array<ArrayBuffer> {
  const grid = powerGrid(state.entities);
  if (range === null || !grid) {
    return new Int32Array(4);
  }
  const { store, occupancy } = state.entities;
  const origins = occupancy.originsIn(range);
  const poles = origins.filter((id) => grid.isPole(id));
  const inRange = new Set(poles);
  const out: number[] = [poles.length];
  const nets = new Set<number>();
  for (const id of poles) {
    const net = grid.networkOfPole(id);
    nets.add(net);
    out.push(id, store.type(id), store.x(id), store.y(id), net);
  }
  const wires: number[] = [];
  for (const id of poles) {
    for (const n of grid.neighbours(id)) {
      if (n > id && inRange.has(n)) wires.push(id, n);
    }
  }
  out.push(wires.length / 2, ...wires);
  const sorted = [...nets].sort((a, b) => a - b);
  out.push(sorted.length);
  for (const net of sorted) {
    const n = grid.network(net)!;
    out.push(net, n.poles, n.demand | 0, n.supply | 0, n.satisfaction);
  }
  const members: number[] = [];
  for (const id of origins) {
    const m = grid.member(id);
    if (m) members.push(id, m.network, m.demand | 0, m.maxOutput | 0, m.drawn | 0);
  }
  out.push(members.length / MEMBER_STRIDE, ...members);
  return Int32Array.from(out);
}

/** A pole as decoded on the main thread. */
export interface PoleData {
  id: number;
  /** Entity type id (a pole prototype). */
  type: number;
  x: number;
  y: number;
  network: number;
}

/** A network as decoded on the main thread. */
export interface NetworkData {
  id: number;
  poles: number;
  demand: number;
  supply: number;
  /** In units of 1/`SAT_ONE`. */
  satisfaction: number;
}

/** An electric entity as decoded on the main thread (joules per tick, as of the latest tick). */
export interface MemberData {
  id: number;
  /** 0 when not connected. */
  network: number;
  demand: number;
  maxOutput: number;
  drawn: number;
}

/** The grid around the view as decoded on the main thread. */
export interface PowerData {
  poles: PoleData[];
  /** Wired pole pairs `[a, b]` with `a < b`. */
  wires: [number, number][];
  networks: NetworkData[];
  members: MemberData[];
}

/** Unpacks a buffer made by {@link encodePower}. */
export function decodePower(buffer: ArrayBuffer): PowerData {
  const v = new Int32Array(buffer);
  const out: PowerData = { poles: [], wires: [], networks: [], members: [] };
  let o = 0;
  const poleCount = v[o++] ?? 0;
  for (let i = 0; i < poleCount && o + POLE_STRIDE <= v.length; i++, o += POLE_STRIDE) {
    out.poles.push({
      id: v[o]! >>> 0,
      type: v[o + 1]!,
      x: v[o + 2]!,
      y: v[o + 3]!,
      network: v[o + 4]! >>> 0,
    });
  }
  const wireCount = v[o++] ?? 0;
  for (let i = 0; i < wireCount && o + 2 <= v.length; i++, o += 2) {
    out.wires.push([v[o]! >>> 0, v[o + 1]! >>> 0]);
  }
  const netCount = v[o++] ?? 0;
  for (let i = 0; i < netCount && o + NETWORK_STRIDE <= v.length; i++, o += NETWORK_STRIDE) {
    out.networks.push({
      id: v[o]! >>> 0,
      poles: v[o + 1]!,
      demand: v[o + 2]! >>> 0,
      supply: v[o + 3]! >>> 0,
      satisfaction: v[o + 4]!,
    });
  }
  const memberCount = v[o++] ?? 0;
  for (let i = 0; i < memberCount && o + MEMBER_STRIDE <= v.length; i++, o += MEMBER_STRIDE) {
    out.members.push({
      id: v[o]! >>> 0,
      network: v[o + 1]! >>> 0,
      demand: v[o + 2]! >>> 0,
      maxOutput: v[o + 3]! >>> 0,
      drawn: v[o + 4]! >>> 0,
    });
  }
  return out;
}

/** Field offsets of the header of {@link encodeNetworkDetail}; the groups follow it. */
export const NetworkDetailField = {
  /** The pole asked about, and its network. */
  pole: 0,
  network: 1,
  poles: 2,
  /** Joules per tick wanted by the consumers and the most the producers could deliver. */
  demand: 3,
  supply: 4,
  /** In units of 1/`SAT_ONE`. */
  satisfaction: 5,
  /** Joules per tick delivered: `min(supply, demand)`. */
  load: 6,
  groupCount: 7,
} as const;
const NETWORK_DETAIL_HEADER = 8;
/** Int32 fields per group in {@link encodeNetworkDetail}. */
export const NETWORK_GROUP_STRIDE = 6;

/**
 * Encodes what the power panel shows about the network of pole `id` as
 * int32s: the {@link NetworkDetailField} header (as of the latest tick,
 * over the whole network, wherever its entities are), then one group per
 * entity type on the network, ascending type ids: `[type, producer, count,
 * demand, maxOutput, power]`, with `producer` 1 for generators, `power` what
 * the group delivered (producers) or drew (consumers, `poweredEnergy` of
 * each one's demand) on the latest tick. Joules are uint32s stored bit for
 * bit. `null` when `id` isn't a pole.
 *
 * Read-only and computed on request (only while a power panel is open):
 * the 60 s graph is sampled on the main thread from snapshots, not kept in
 * the simulation.
 */
export function encodeNetworkDetail(state: SimState, id: number): Int32Array<ArrayBuffer> | null {
  const { entities } = state;
  const grid = powerGrid(entities);
  if (!grid?.isPole(id)) return null;
  const net = grid.networkOfPole(id);
  const stats = grid.network(net);
  const groups = new Map<number, number[]>();
  const sat = stats?.satisfaction ?? 0;
  for (const m of grid.membersOf(net)) {
    const type = entities.store.type(m);
    const member = grid.member(m)!;
    const producer = entities.table(type)?.powerMaxOutput !== undefined;
    let g = groups.get(type);
    if (!g) groups.set(type, (g = [type, producer ? 1 : 0, 0, 0, 0, 0]));
    g[2]! += 1;
    g[3]! += member.demand;
    g[4]! += member.maxOutput;
    g[5]! += producer ? member.drawn : poweredEnergy(member.demand, sat);
  }
  const sorted = [...groups.values()].sort((a, b) => a[0]! - b[0]!);
  const out = new Int32Array(NETWORK_DETAIL_HEADER + sorted.length * NETWORK_GROUP_STRIDE);
  out[NetworkDetailField.pole] = id;
  out[NetworkDetailField.network] = net;
  out[NetworkDetailField.poles] = stats?.poles ?? 0;
  out[NetworkDetailField.demand] = stats?.demand ?? 0;
  out[NetworkDetailField.supply] = stats?.supply ?? 0;
  out[NetworkDetailField.satisfaction] = sat;
  out[NetworkDetailField.load] = stats?.load ?? 0;
  out[NetworkDetailField.groupCount] = sorted.length;
  sorted.forEach((g, i) => {
    out.set(g, NETWORK_DETAIL_HEADER + i * NETWORK_GROUP_STRIDE);
  });
  return out;
}

/** The entities of one type on a network, as decoded on the main thread. */
export interface NetworkGroupData {
  type: number;
  /** Generators (true) or consumers. */
  producer: boolean;
  count: number;
  /** Joules per tick, as of the latest tick. */
  demand: number;
  maxOutput: number;
  /** Delivered (producers) or drawn (consumers). */
  power: number;
}

/** A network as the power panel shows it, decoded on the main thread. */
export interface NetworkDetailData {
  pole: number;
  network: number;
  poles: number;
  demand: number;
  supply: number;
  satisfaction: number;
  load: number;
  groups: NetworkGroupData[];
}

/** Unpacks a buffer made by {@link encodeNetworkDetail}. */
export function decodeNetworkDetail(buffer: ArrayBuffer): NetworkDetailData {
  const v = new Int32Array(buffer);
  const u = (i: number): number => (v[i] ?? 0) >>> 0;
  const groups: NetworkGroupData[] = [];
  const n = Math.min(
    v[NetworkDetailField.groupCount] ?? 0,
    Math.floor((v.length - NETWORK_DETAIL_HEADER) / NETWORK_GROUP_STRIDE),
  );
  for (let i = 0; i < n; i++) {
    const o = NETWORK_DETAIL_HEADER + i * NETWORK_GROUP_STRIDE;
    groups.push({
      type: v[o]!,
      producer: v[o + 1] === 1,
      count: v[o + 2]!,
      demand: u(o + 3),
      maxOutput: u(o + 4),
      power: u(o + 5),
    });
  }
  return {
    pole: u(NetworkDetailField.pole),
    network: u(NetworkDetailField.network),
    poles: v[NetworkDetailField.poles] ?? 0,
    demand: u(NetworkDetailField.demand),
    supply: u(NetworkDetailField.supply),
    satisfaction: v[NetworkDetailField.satisfaction] ?? 0,
    load: u(NetworkDetailField.load),
    groups,
  };
}

/** Int32 fields per technology in {@link encodeResearch}, after the 2-field header. */
export const RESEARCH_TECH_STRIDE = 4;

/**
 * Encodes the research of player `playerId`'s force as int32s: `[current,
 * techCount]`, then per technology in `TECH_IDS` order `[id, unitsDone,
 * unitsInProgress, ticksInProgress]` (units researched, units labs are
 * researching now, and the whole working ticks done on those, summed over
 * the labs). Sent in every snapshot: a few dozen bytes.
 */
export function encodeResearch(state: SimState, playerId: number): Int32Array<ArrayBuffer> {
  const force = forceOf(state, playerId);
  const labs = labTable(state.entities);
  const out = new Int32Array(2 + TECH_IDS.length * RESEARCH_TECH_STRIDE);
  out[0] = state.research.currentOf(force);
  out[1] = TECH_IDS.length;
  TECH_IDS.forEach((tech, i) => {
    const o = 2 + i * RESEARCH_TECH_STRIDE;
    out[o] = tech;
    out[o + 1] = state.research.unitsDone(force, tech);
    out[o + 2] = labs?.unitsInProgress(tech) ?? 0;
    out[o + 3] = labs?.ticksInProgress(tech) ?? 0;
  });
  return out;
}

/** The research of the local player's force as decoded on the main thread. */
export interface ResearchData {
  /** The current research (0: none). */
  current: number;
  /** Per technology id: units researched, units in progress and their working ticks so far. */
  techs: Map<number, { unitsDone: number; unitsInProgress: number; ticksInProgress: number }>;
}

/** Unpacks a buffer made by {@link encodeResearch}. */
export function decodeResearch(buffer: ArrayBuffer): ResearchData {
  const v = new Int32Array(buffer, 0, buffer.byteLength >> 2);
  const n = Math.min(v[1] ?? 0, Math.floor((v.length - 2) / RESEARCH_TECH_STRIDE));
  const techs: ResearchData['techs'] = new Map();
  for (let i = 0; i < n; i++) {
    const o = 2 + i * RESEARCH_TECH_STRIDE;
    techs.set(v[o]!, {
      unitsDone: v[o + 1]!,
      unitsInProgress: v[o + 2]!,
      ticksInProgress: v[o + 3]!,
    });
  }
  return { current: v[0] ?? 0, techs };
}

/** An empty research (before the first snapshot): nothing researched, nothing current. */
export const NO_RESEARCH: ResearchData = { current: 0, techs: new Map() };

/**
 * Whether recipe `recipe` is unlocked by `research` (the main thread's copy
 * of the simulation's `isRecipeUnlocked`).
 */
export function researchUnlocks(research: ResearchData, recipe: number): boolean {
  return recipeUnlockedBy((tech) => isResearchedIn(research, tech), recipe);
}

/** Whether `research` has technology `tech` researched. */
export function isResearchedIn(research: ResearchData, tech: number): boolean {
  const t = technologyPrototype(tech);
  return t !== undefined && (research.techs.get(tech)?.unitsDone ?? 0) >= t.units;
}

/** Field offsets of the header of {@link encodeEntityDetail}; `[item, count]` slot pairs follow it. */
export const DetailField = {
  id: 0,
  type: 1,
  /** 1 if the player can reach the entity (to use its GUI), else 0. */
  reachable: 2,
  status: 3,
  recipe: 4,
  progress: 5,
  energy: 6,
  burning: 7,
  /**
   * Joules per tick of electric power on the latest tick: delivered
   * (generators, boilers) or drawn (electric consumers).
   */
  power: 8,
  /** The electric network the entity belongs to (0: none, or not electric) and its satisfaction. */
  network: 9,
  satisfaction: 10,
  /** A lab's unit in progress: its technology (0: none). */
  technology: 11,
  slotCount: 12,
} as const;
const DETAIL_HEADER = 13;

/**
 * The recipes player `playerId` can set entity `id` to, in id order: those
 * it can make (`allowsRecipe`) that the player's force has unlocked
 * (`isRecipeUnlocked`). Empty for entities without a recipe picker.
 */
export function recipeOptions(state: SimState, playerId: number, id: number): number[] {
  const { entities } = state;
  if (entities.table(entities.store.type(id))?.setRecipe === undefined) return [];
  const force = forceOf(state, playerId);
  return RECIPE_IDS.filter(
    (r) => entities.allowsRecipe(id, r) && isRecipeUnlocked(state, force, r),
  );
}

/**
 * Encodes what the entity GUI shows about entity `id` for player `playerId`
 * as int32s: the {@link DetailField} header, one `[item, count]` pair per
 * slot, then `[optionCount]` and the recipes its recipe picker offers
 * (`recipeOptions`; none for entities without one). `recipe` is the recipe
 * set (assembling machines) or being made (furnaces). `null` when there is
 * no such entity.
 */
export function encodeEntityDetail(
  state: SimState,
  playerId: number,
  id: number,
): Int32Array<ArrayBuffer> | null {
  const { entities } = state;
  const type = entities.store.type(id);
  if (type === 0) {
    return null;
  }
  const slots = entities.slots(id);
  const detail = entities.detail(id);
  const options = recipeOptions(state, playerId, id);
  const out = new Int32Array(DETAIL_HEADER + 2 * slots.length + 1 + options.length);
  out[DetailField.id] = id;
  out[DetailField.type] = type;
  out[DetailField.reachable] = reaches(state, playerId, id) ? 1 : 0;
  out[DetailField.status] = displayStatus(state, id);
  out[DetailField.recipe] = detail?.recipe ?? 0;
  out[DetailField.progress] = detail?.progress ?? 0;
  out[DetailField.energy] = detail?.energy ?? 0;
  out[DetailField.burning] = detail?.burning ?? 0;
  const grid = powerGrid(entities);
  out[DetailField.power] = detail?.power ?? consumerDraw(state, id);
  out[DetailField.network] = grid?.networkOf(id) ?? 0;
  out[DetailField.satisfaction] = grid?.satisfaction(id) ?? 0;
  out[DetailField.technology] = detail?.technology ?? 0;
  out[DetailField.slotCount] = slots.length;
  slots.forEach((slot, i) => {
    out[DETAIL_HEADER + 2 * i] = slot.item;
    out[DETAIL_HEADER + 2 * i + 1] = slot.count;
  });
  const o = DETAIL_HEADER + 2 * slots.length;
  out[o] = options.length;
  out.set(options, o + 1);
  return out;
}

/** An entity's GUI data as decoded on the main thread. */
export interface EntityDetailData {
  id: number;
  type: number;
  reachable: boolean;
  status: number;
  recipe: number;
  progress: number;
  energy: number;
  burning: number;
  /** Joules per tick of electric power delivered (producers) or drawn (consumers) on the latest tick. */
  power: number;
  /** Electric network (0: none) and its satisfaction in units of 1/`SAT_ONE`. */
  network: number;
  satisfaction: number;
  /** A lab's unit in progress: its technology (0: none). */
  technology: number;
  slots: SlotData[];
  /** The recipes the entity's recipe picker offers, in id order (empty without a picker). */
  recipeOptions: number[];
}

/** Unpacks a buffer made by {@link encodeEntityDetail}. */
export function decodeEntityDetail(buffer: ArrayBuffer): EntityDetailData {
  const v = new Int32Array(buffer);
  const slots: SlotData[] = [];
  const n = v[DetailField.slotCount] ?? 0;
  for (let i = 0; i < n; i++) {
    slots.push({ item: v[DETAIL_HEADER + 2 * i]!, count: v[DETAIL_HEADER + 2 * i + 1]! });
  }
  const o = DETAIL_HEADER + 2 * n;
  const recipeCount = Math.max(0, Math.min(v[o] ?? 0, v.length - o - 1));
  const recipeOptions = Array.from(v.subarray(o + 1, o + 1 + recipeCount));
  return {
    id: v[DetailField.id]! >>> 0,
    type: v[DetailField.type]!,
    reachable: v[DetailField.reachable] === 1,
    status: v[DetailField.status]!,
    recipe: v[DetailField.recipe]!,
    progress: v[DetailField.progress]!,
    energy: v[DetailField.energy]!,
    burning: v[DetailField.burning]!,
    power: v[DetailField.power]! >>> 0,
    network: v[DetailField.network]! >>> 0,
    satisfaction: v[DetailField.satisfaction]!,
    technology: v[DetailField.technology]!,
    slots,
    recipeOptions,
  };
}

/** One inventory slot as decoded on the main thread; `item` 0 is an empty slot. */
export interface SlotData {
  item: number;
  count: number;
}

/** Unpacks a buffer made by {@link encodeInventory}. */
export function decodeInventory(buffer: ArrayBuffer): SlotData[] {
  const view = new Uint16Array(buffer, 0, (buffer.byteLength >> 2) << 1);
  const out: SlotData[] = [];
  for (let i = 0; i + 1 < view.length; i += 2) {
    out.push({ item: view[i]!, count: view[i + 1]! });
  }
  return out;
}

/** Byte offsets of the fields within one chunk record of {@link encodeChunks}. */
const RECORD_TERRAIN = 8;
const RECORD_RESOURCE = RECORD_TERRAIN + CHUNK_AREA;
const RECORD_TREE = RECORD_RESOURCE + CHUNK_AREA;
const RECORD_AMOUNT = RECORD_TREE + CHUNK_AREA;

/**
 * Bytes per chunk record in {@link encodeChunks}:
 * `cx: int32, cy: int32, terrain: uint8[CHUNK_AREA], resource: uint8[CHUNK_AREA],
 * tree: uint8[CHUNK_AREA], amount: uint32[CHUNK_AREA]`. Every field starts at
 * a multiple of 4 bytes.
 */
export const CHUNK_RECORD_BYTES = RECORD_AMOUNT + 4 * CHUNK_AREA;

/** Terrain, resources and trees of one chunk (a `Chunk`, or one decoded on the main thread). */
export interface ChunkData {
  /** Chunk coordinates (in chunks, not tiles). */
  readonly cx: number;
  readonly cy: number;
  /** Row-major per-tile arrays of length `CHUNK_AREA`, as in src/sim/world/chunk.ts. */
  readonly terrain: Uint8Array;
  readonly resource: Uint8Array;
  readonly amount: Uint32Array;
  /** 1 where a tree stands, else 0. */
  readonly tree: Uint8Array;
}

/** Packs the terrain, resources and trees of `chunks` into one transferable buffer. */
export function encodeChunks(chunks: readonly ChunkData[]): ArrayBuffer {
  const buffer = new ArrayBuffer(chunks.length * CHUNK_RECORD_BYTES);
  chunks.forEach((chunk, i) => {
    const r = recordViews(buffer, i);
    r.coords[0] = chunk.cx;
    r.coords[1] = chunk.cy;
    r.terrain.set(chunk.terrain);
    r.resource.set(chunk.resource);
    r.amount.set(chunk.amount);
    r.tree.set(chunk.tree);
  });
  return buffer;
}

/**
 * Unpacks a buffer made by {@link encodeChunks}, in the same order. The arrays
 * are views into `buffer`, not copies.
 */
export function decodeChunks(buffer: ArrayBuffer): ChunkData[] {
  if (buffer.byteLength % CHUNK_RECORD_BYTES !== 0) {
    throw new RangeError(
      `chunk buffer of ${String(buffer.byteLength)} bytes is not a whole number of records`,
    );
  }
  const out: ChunkData[] = [];
  const count = buffer.byteLength / CHUNK_RECORD_BYTES;
  for (let i = 0; i < count; i++) {
    const r = recordViews(buffer, i);
    out.push({
      cx: r.coords[0]!,
      cy: r.coords[1]!,
      terrain: r.terrain,
      resource: r.resource,
      amount: r.amount,
      tree: r.tree,
    });
  }
  return out;
}

function recordViews(
  buffer: ArrayBuffer,
  index: number,
): {
  coords: Int32Array;
  terrain: Uint8Array;
  resource: Uint8Array;
  amount: Uint32Array;
  tree: Uint8Array;
} {
  const base = index * CHUNK_RECORD_BYTES;
  return {
    // [cx, cy]
    coords: new Int32Array(buffer, base, 2),
    terrain: new Uint8Array(buffer, base + RECORD_TERRAIN, CHUNK_AREA),
    resource: new Uint8Array(buffer, base + RECORD_RESOURCE, CHUNK_AREA),
    amount: new Uint32Array(buffer, base + RECORD_AMOUNT, CHUNK_AREA),
    tree: new Uint8Array(buffer, base + RECORD_TREE, CHUNK_AREA),
  };
}
