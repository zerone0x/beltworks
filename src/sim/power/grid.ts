/**
 * The electric grid: poles, the networks they form, which network each
 * electric entity belongs to, and the per-tick power solver.
 *
 * It is the entity table of the small electric pole (the only pole type so
 * far; more pole types would register with the same grid) and sees every
 * other entity through the `entityPlaced`/`entityRotated`/`entityRemoved`
 * hooks.
 *
 * **Wires.** A placed pole connects to every pole whose center lies within
 * wire reach (`polesConnect` in geometry.ts), found through the occupancy
 * index. Wires are symmetric; each pole keeps its neighbours sorted by id.
 * Entity ids only grow, so a new pole is appended to its neighbours' lists.
 *
 * **Networks** are the connected components of the wire graph, kept with a
 * union-find over pole ids (path compression, union by size). Each network
 * has an id (from a counter, never reused); the root of its union-find tree
 * holds it. Placing a pole unions it with each neighbour: when that merges
 * networks, the lowest id survives and the others are dropped. Removing a
 * pole rebuilds only its own network: a breadth-first walk over the wires
 * from each of its neighbours (in id order) finds the pieces left; the first
 * keeps the network's id, every other gets a new one, and each piece gets a
 * flat union-find tree.
 *
 * **Membership.** A type whose table implements `powerDemand` (consumer) or
 * `powerMaxOutput` (producer) is electric. Each electric entity is tied to
 * the pole with the lowest id among those whose supply area covers any of
 * its tiles (none: not connected), and belongs to that pole's network. The
 * lowest pole id rather than the lowest network id, because pole ids never
 * change: a merge or split moves an entity's network with its pole, and
 * only placing or removing a pole near it, or placing or rotating the
 * entity itself, can change its pole.
 *
 * **Solver** (`update`, the power system, run each tick before every
 * consumer): first every table's `powerPrepare` hook (steam engines share
 * out their boilers' supply there); then for each network, sum the demand
 * of its consumers and the maximum output of its producers; compute the
 * satisfaction (solver.ts);
 * then tell each producer its share of the load. Consumers read their
 * network's satisfaction back with `satisfaction(id)` when their own system
 * runs later in the tick. With no producers, a network with demand has
 * satisfaction 0.
 *
 * Everything is hashed in row order; the union-find parents are not (path
 * compression may change them on reads), only each pole's resolved network.
 */

import { EntityTypeId } from '../../data/entities';
import type { ItemStack } from '../../data/items';
import type { Entities } from '../entities/entities';
import { SparseSet, growTo } from '../entities/sparseSet';
import type { EntityTypeTable } from '../entities/table';
import { fnv1a32 } from '../hash';
import {
  MAX_SUPPLY_RADIUS,
  MAX_WIRE_REACH,
  polesConnect,
  rectsOverlap,
  supplyRect,
} from './geometry';
import { producerShare, satisfactionFor } from './solver';

const U32_MAX = 0xffff_ffff;
const NO_CONTENTS: readonly ItemStack[] = [];

/** Adds two joule counts, saturating at the uint32 limit of the columns. */
const addJoules = (a: number, b: number): number => Math.min(U32_MAX, a + b);

/** What the grid knows about one network after the latest tick. */
export interface NetworkStats {
  id: number;
  poles: number;
  /** Joules wanted by its consumers, and the most its producers could deliver. */
  demand: number;
  supply: number;
  /** `min(1, supply / demand)` in units of 1/`SAT_ONE`. */
  satisfaction: number;
  /** Joules delivered: `min(supply, demand)`. */
  load: number;
}

/** What the grid knows about one electric entity after the latest tick. */
export interface MemberStats {
  /** The pole it is tied to and its network, 0 when not connected. */
  pole: number;
  network: number;
  /** Joules it wanted (consumers), could deliver and delivered (producers). */
  demand: number;
  maxOutput: number;
  drawn: number;
}

export class PowerGrid implements EntityTypeTable {
  readonly type = EntityTypeId.SmallElectricPole;

  // Poles, in the row order of `poles`.
  private readonly poles = new SparseSet();
  /** Union-find parent (a pole id; the pole itself at a root). */
  private parent = new Uint32Array(0);
  /** Poles in the tree; meaningful at roots. */
  private size = new Uint32Array(0);
  /** Network id; meaningful at roots (0 for a new pole before it joins one). */
  private rootNet = new Uint32Array(0);
  /** Wired neighbours per pole, ascending ids. */
  private neighbourLists: number[][] = [];

  // Networks, in the row order of `nets`.
  private readonly nets = new SparseSet();
  private netPoles = new Uint32Array(0);
  private netDemand = new Uint32Array(0);
  private netSupply = new Uint32Array(0);
  private netSat = new Uint32Array(0);
  private netLoad = new Uint32Array(0);
  /** Scratch for `update`: maximum output of the producers seen so far. Not state. */
  private netCum = new Uint32Array(0);
  private nextNet = 1;

  // Electric entities, in the row order of `members`.
  private readonly members = new SparseSet();
  private memType = new Uint8Array(0);
  /** The pole the entity is tied to, or 0. */
  private memPole = new Uint32Array(0);
  /** The network of `memPole`, cached; refreshed whenever networks change (`netsDirty`). */
  private memNet = new Uint32Array(0);
  private memDemand = new Uint32Array(0);
  private memOutput = new Uint32Array(0);
  private memDrawn = new Uint32Array(0);
  private netsDirty = false;

  private readonly tables: (EntityTypeTable | null | undefined)[] = [];

  /** Number of poles. */
  get poleCount(): number {
    return this.poles.size;
  }

  /** Number of networks. */
  get networkCount(): number {
    return this.nets.size;
  }

  /** Number of electric entities (connected or not). */
  get memberCount(): number {
    return this.members.size;
  }

  // Entity table hooks.

  /** A pole was placed: wire it up, merge networks, and tie the entities around it to it. */
  add(id: number, entities: Entities): void {
    const row = this.poles.add(id);
    const min = row + 1;
    this.parent = growTo(this.parent, min);
    this.size = growTo(this.size, min);
    this.rootNet = growTo(this.rootNet, min);
    this.parent[row] = id;
    this.size[row] = 1;
    this.rootNet[row] = 0;
    const neighbours = this.polesInReach(id, entities);
    this.neighbourLists[row] = neighbours;
    for (const n of neighbours) {
      this.neighbourLists[this.poleRow(n)]!.push(id);
      this.union(id, n);
    }
    const root = this.poleRow(this.find(id));
    if (this.rootNet[root] === 0) {
      this.rootNet[root] = this.addNetwork(1);
    }
    this.netsDirty = true;
    // Entities with no pole yet get this one; the rest keep theirs (lower ids).
    for (const m of this.membersAround(id, entities)) {
      const i = this.members.indexOf(m);
      if (this.memPole[i] === 0) this.memPole[i] = id;
    }
  }

  contents(): readonly ItemStack[] {
    return NO_CONTENTS;
  }

  /** A pole is about to go: unwire it, rebuild its network, re-tie the entities that used it. */
  remove(id: number, entities: Entities): void {
    const row = this.poles.indexOf(id);
    if (row < 0) return;
    const net = this.rootNet[this.poleRow(this.find(id))]!;
    const neighbours = this.neighbourLists[row]!;
    for (const n of neighbours) {
      const list = this.neighbourLists[this.poleRow(n)]!;
      list.splice(list.indexOf(id), 1);
    }
    const around = this.membersAround(id, entities);
    this.removePoleRow(id);
    this.rebuildNetwork(net, neighbours);
    this.netsDirty = true;
    for (const m of around) {
      const i = this.members.indexOf(m);
      if (this.memPole[i] === id) this.memPole[i] = this.coveringPole(m, entities);
    }
  }

  entityPlaced(id: number, entities: Entities): void {
    if (!this.isElectric(entities.store.type(id), entities)) return;
    const i = this.members.add(id);
    const min = i + 1;
    this.memType = growTo(this.memType, min);
    this.memPole = growTo(this.memPole, min);
    this.memNet = growTo(this.memNet, min);
    this.memDemand = growTo(this.memDemand, min);
    this.memOutput = growTo(this.memOutput, min);
    this.memDrawn = growTo(this.memDrawn, min);
    this.memType[i] = entities.store.type(id);
    this.memPole[i] = this.coveringPole(id, entities);
    this.memNet[i] = this.memPole[i] !== 0 ? this.networkOfPole(this.memPole[i]) : 0;
  }

  /** A turned entity may cover other tiles (non-square footprints). */
  entityRotated(id: number, entities: Entities): void {
    const i = this.members.indexOf(id);
    if (i < 0) return;
    this.memPole[i] = this.coveringPole(id, entities);
    this.memNet[i] = this.memPole[i] !== 0 ? this.networkOfPole(this.memPole[i]) : 0;
  }

  entityRemoved(id: number): void {
    const i = this.members.remove(id);
    if (i < 0) return;
    const last = this.members.size;
    const columns = [
      this.memType,
      this.memPole,
      this.memNet,
      this.memDemand,
      this.memOutput,
      this.memDrawn,
    ];
    if (i !== last) {
      for (const c of columns) c[i] = c[last]!;
    }
    for (const c of columns) c[last] = 0;
  }

  // Reads.

  /** Whether entity `id` is a pole. */
  isPole(id: number): boolean {
    return this.poles.has(id);
  }

  /** The network of pole `id`, or 0 if it isn't a pole. */
  networkOfPole(id: number): number {
    if (!this.poles.has(id)) return 0;
    return this.rootNet[this.poleRow(this.find(id))]!;
  }

  /** The poles wired to pole `id`, ascending (a copy; empty if it isn't a pole). */
  neighbours(id: number): number[] {
    const row = this.poles.indexOf(id);
    return row < 0 ? [] : this.neighbourLists[row]!.slice();
  }

  /** Network ids, in row order (a copy). */
  networkIds(): number[] {
    return Array.from(this.nets.dense);
  }

  /** Network `net` as of the latest tick, or `undefined` if there is none. */
  network(net: number): NetworkStats | undefined {
    const r = this.nets.indexOf(net);
    if (r < 0) return undefined;
    return {
      id: net,
      poles: this.netPoles[r]!,
      demand: this.netDemand[r]!,
      supply: this.netSupply[r]!,
      satisfaction: this.netSat[r]!,
      load: this.netLoad[r]!,
    };
  }

  /** The network electric entity `id` belongs to, or 0 (not connected, or not electric). */
  networkOf(id: number): number {
    const i = this.members.indexOf(id);
    if (i < 0) return 0;
    this.refreshNetworks();
    return this.memNet[i]!;
  }

  /**
   * Satisfaction (in units of 1/`SAT_ONE`) of the network electric entity
   * `id` belongs to, as computed by this tick's power step; 0 when it isn't
   * connected. Consumers scale their speed and energy by it.
   */
  satisfaction(id: number): number {
    const r = this.nets.indexOf(this.networkOf(id));
    return r < 0 ? 0 : this.netSat[r]!;
  }

  /** Electric entity `id` as of the latest tick, or `undefined` if it isn't one. */
  member(id: number): MemberStats | undefined {
    const i = this.members.indexOf(id);
    if (i < 0) return undefined;
    this.refreshNetworks();
    return {
      pole: this.memPole[i]!,
      network: this.memNet[i]!,
      demand: this.memDemand[i]!,
      maxOutput: this.memOutput[i]!,
      drawn: this.memDrawn[i]!,
    };
  }

  /**
   * The electric entities on network `net` as of the latest tick, in row
   * order (a scan over every electric entity; for the power panel, not for
   * hot paths).
   */
  membersOf(net: number): number[] {
    const out: number[] = [];
    if (net === 0) return out;
    this.refreshNetworks();
    for (let i = 0; i < this.members.size; i++) {
      if (this.memNet[i] === net) out.push(this.members.idAt(i));
    }
    return out;
  }

  // The power system.

  /** Solves every network for this tick and tells the producers what to deliver. */
  update(entities: Entities): void {
    this.refreshNetworks();
    for (const table of entities.tables) table.powerPrepare?.(entities);
    const nNets = this.nets.size;
    this.netDemand.fill(0, 0, nNets);
    this.netSupply.fill(0, 0, nNets);
    this.netCum.fill(0, 0, nNets);
    const n = this.members.size;
    // Pass 1: demand and available supply per network.
    for (let i = 0; i < n; i++) {
      const id = this.members.idAt(i);
      const r = this.nets.indexOf(this.memNet[i]!);
      if (r < 0) {
        this.memDemand[i] = 0;
        this.memOutput[i] = 0;
        continue;
      }
      const table = this.tableOf(this.memType[i]!, entities)!;
      const demand = table.powerDemand ? joules(table.powerDemand(id, entities)) : 0;
      const output = table.powerMaxOutput ? joules(table.powerMaxOutput(id, entities)) : 0;
      this.memDemand[i] = demand;
      this.memOutput[i] = output;
      this.netDemand[r] = addJoules(this.netDemand[r]!, demand);
      this.netSupply[r] = addJoules(this.netSupply[r]!, output);
    }
    for (let r = 0; r < nNets; r++) {
      const demand = this.netDemand[r]!;
      const supply = this.netSupply[r]!;
      this.netSat[r] = satisfactionFor(demand, supply);
      this.netLoad[r] = Math.min(demand, supply);
    }
    // Pass 2: each producer's share of its network's load.
    for (let i = 0; i < n; i++) {
      const table = this.tableOf(this.memType[i]!, entities)!;
      if (!table.powerMaxOutput) continue;
      const r = this.nets.indexOf(this.memNet[i]!);
      let drawn = 0;
      if (r >= 0) {
        const before = this.netCum[r]!;
        const max = this.memOutput[i]!;
        this.netCum[r] = before + max;
        drawn = producerShare(this.netLoad[r]!, this.netSupply[r]!, before, max);
      }
      this.memDrawn[i] = drawn;
      table.powerDraw?.(this.members.idAt(i), drawn, entities);
    }
  }

  hashInto(h: number): number {
    this.refreshNetworks();
    const nPoles = this.poles.size;
    h = fnv1a32(Uint32Array.of(nPoles, this.nets.size, this.members.size, this.nextNet), h);
    h = fnv1a32(this.poles.dense, h);
    const wires: number[] = [];
    for (let row = 0; row < nPoles; row++) {
      const list = this.neighbourLists[row]!;
      wires.push(this.networkOfPole(this.poles.idAt(row)), list.length, ...list);
    }
    h = fnv1a32(Uint32Array.from(wires), h);
    const nNets = this.nets.size;
    h = fnv1a32(this.nets.dense, h);
    for (const c of [this.netPoles, this.netDemand, this.netSupply, this.netSat, this.netLoad]) {
      h = fnv1a32(c.subarray(0, nNets), h);
    }
    const n = this.members.size;
    h = fnv1a32(this.members.dense, h);
    h = fnv1a32(this.memType.subarray(0, n), h);
    for (const c of [this.memPole, this.memNet, this.memDemand, this.memOutput, this.memDrawn]) {
      h = fnv1a32(c.subarray(0, n), h);
    }
    return h;
  }

  // Internals.

  /** Poles (other than `id`) that pole `id` connects to, ascending. */
  private polesInReach(id: number, entities: Entities): number[] {
    const { x, y, w, h } = entities.footprint(id);
    const proto = entities.prototypeOf(id)!;
    const R = MAX_WIRE_REACH;
    const found: number[] = [];
    for (let ty = y - R; ty < y + h + R; ty++) {
      for (let tx = x - R; tx < x + w + R; tx++) {
        const q = entities.at(tx, ty);
        if (q === 0 || q === id || !this.poles.has(q) || found.includes(q)) continue;
        const other = entities.prototypeOf(q)!;
        if (polesConnect(proto, x, y, other, entities.store.x(q), entities.store.y(q))) {
          found.push(q);
        }
      }
    }
    return found.sort((a, b) => a - b);
  }

  /** Electric entities with a tile in the supply area of pole `id`, in first-seen order. */
  private membersAround(id: number, entities: Entities): number[] {
    const { x0, y0, x1, y1 } = supplyRect(
      entities.prototypeOf(id)!,
      entities.store.x(id),
      entities.store.y(id),
    );
    const out: number[] = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const e = entities.at(tx, ty);
        if (e !== 0 && this.members.has(e) && !out.includes(e)) out.push(e);
      }
    }
    return out;
  }

  /** The lowest-id pole whose supply area covers a tile of entity `id`, or 0. */
  private coveringPole(id: number, entities: Entities): number {
    const { x, y, w, h } = entities.footprint(id);
    const footprint = { x0: x, y0: y, x1: x + w - 1, y1: y + h - 1 };
    const R = MAX_SUPPLY_RADIUS;
    let best = 0;
    for (let ty = y - R; ty < y + h + R; ty++) {
      for (let tx = x - R; tx < x + w + R; tx++) {
        const q = entities.at(tx, ty);
        if (q === 0 || !this.poles.has(q) || (best !== 0 && q >= best)) continue;
        const area = supplyRect(entities.prototypeOf(q)!, entities.store.x(q), entities.store.y(q));
        if (rectsOverlap(area, footprint)) best = q;
      }
    }
    return best;
  }

  /** Recomputes every member's cached network after networks merged or split. */
  private refreshNetworks(): void {
    if (!this.netsDirty) return;
    this.netsDirty = false;
    for (let i = 0; i < this.members.size; i++) {
      const pole = this.memPole[i]!;
      this.memNet[i] = pole !== 0 ? this.networkOfPole(pole) : 0;
    }
  }

  private find(id: number): number {
    let root = id;
    for (
      let p = this.parent[this.poleRow(root)]!;
      p !== root;
      p = this.parent[this.poleRow(root)]!
    ) {
      root = p;
    }
    // Path compression.
    for (let c = id; c !== root;) {
      const row = this.poleRow(c);
      c = this.parent[row]!;
      this.parent[row] = root;
    }
    return root;
  }

  /** Joins the trees of poles `a` and `b`; merged networks keep the lower id. */
  private union(a: number, b: number): void {
    let ra = this.poleRow(this.find(a));
    let rb = this.poleRow(this.find(b));
    if (ra === rb) return;
    const netA = this.rootNet[ra]!;
    const netB = this.rootNet[rb]!;
    const keep = netA === 0 ? netB : netB === 0 ? netA : Math.min(netA, netB);
    const gone = netA !== 0 && netB !== 0 ? Math.max(netA, netB) : 0;
    if (this.size[ra]! < this.size[rb]!) [ra, rb] = [rb, ra];
    this.parent[rb] = this.poles.idAt(ra);
    this.size[ra] = this.size[ra]! + this.size[rb]!;
    this.rootNet[rb] = 0;
    if (gone !== 0) this.removeNetwork(gone);
    this.rootNet[ra] = keep;
    if (keep !== 0) this.netPoles[this.nets.indexOf(keep)] = this.size[ra]!;
  }

  /**
   * Network `net` lost a pole whose neighbours were `neighbours` (ascending):
   * finds the pieces left by walking the wires from each, keeps `net` for
   * the first and gives every other a new id. Drops `net` if nothing is left.
   */
  private rebuildNetwork(net: number, neighbours: readonly number[]): void {
    const seen = new Set<number>();
    let first = true;
    for (const start of neighbours) {
      if (seen.has(start)) continue;
      const piece = [start];
      seen.add(start);
      for (let k = 0; k < piece.length; k++) {
        for (const n of this.neighbourLists[this.poleRow(piece[k]!)]!) {
          if (!seen.has(n)) {
            seen.add(n);
            piece.push(n);
          }
        }
      }
      const id = first ? net : this.addNetwork(piece.length);
      if (first) this.netPoles[this.nets.indexOf(net)] = piece.length;
      first = false;
      const rootRow = this.poleRow(start);
      for (const p of piece) this.parent[this.poleRow(p)] = start;
      this.size[rootRow] = piece.length;
      this.rootNet[rootRow] = id;
    }
    if (first) this.removeNetwork(net);
  }

  private addNetwork(poles: number): number {
    const id = this.nextNet++;
    const r = this.nets.add(id);
    const min = r + 1;
    this.netPoles = growTo(this.netPoles, min);
    this.netDemand = growTo(this.netDemand, min);
    this.netSupply = growTo(this.netSupply, min);
    this.netSat = growTo(this.netSat, min);
    this.netLoad = growTo(this.netLoad, min);
    this.netCum = growTo(this.netCum, min);
    this.netPoles[r] = poles;
    return id;
  }

  private removeNetwork(net: number): void {
    const r = this.nets.remove(net);
    if (r < 0) return;
    const last = this.nets.size;
    const columns = [this.netPoles, this.netDemand, this.netSupply, this.netSat, this.netLoad];
    if (r !== last) {
      for (const c of columns) c[r] = c[last]!;
    }
    for (const c of columns) c[last] = 0;
  }

  private removePoleRow(id: number): void {
    const row = this.poles.remove(id);
    const last = this.poles.size;
    if (row !== last) {
      this.parent[row] = this.parent[last]!;
      this.size[row] = this.size[last]!;
      this.rootNet[row] = this.rootNet[last]!;
      this.neighbourLists[row] = this.neighbourLists[last]!;
    }
    this.parent[last] = 0;
    this.size[last] = 0;
    this.rootNet[last] = 0;
    this.neighbourLists.length = last;
  }

  private isElectric(type: number, entities: Entities): boolean {
    const table = this.tableOf(type, entities);
    return (
      table !== null && (table.powerDemand !== undefined || table.powerMaxOutput !== undefined)
    );
  }

  private tableOf(type: number, entities: Entities): EntityTypeTable | null {
    let table = this.tables[type];
    if (table === undefined) {
      table = entities.table(type) ?? null;
      this.tables[type] = table;
    }
    return table;
  }

  private poleRow(id: number): number {
    const row = this.poles.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no pole ${String(id)}`);
    }
    return row;
  }
}

/** Checks a joule count reported by a power hook. */
function joules(v: number): number {
  if (!Number.isInteger(v) || v < 0) {
    throw new RangeError(`power hooks must report non-negative integer joules, got ${String(v)}`);
  }
  return Math.min(v, U32_MAX);
}

/** The power grid of `entities`, if one is registered. */
export function powerGrid(entities: Entities): PowerGrid | undefined {
  const table = entities.table(EntityTypeId.SmallElectricPole);
  return table instanceof PowerGrid ? table : undefined;
}
