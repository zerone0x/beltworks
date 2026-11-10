/**
 * Tooltips (plain DOM, D39) on items, recipes and entities: the name, the
 * recipe (ingredients and crafting time) and, for what places an entity,
 * its power use, size and main figures.
 *
 * The text comes from pure functions of the prototypes (`itemTooltip`,
 * `recipeTooltip`, `entityTooltip`), unit-tested in Node. The `Tooltips`
 * element shows one for whatever element under the pointer carries a
 * `data-tip` attribute (`item:<id>`, `recipe:<id>` or `entity:<type id>`,
 * with `@<id>` after a recipe for the machine making it, e.g. an assembler's
 * recipe picker; slots set it from the item they show, see inventory.ts), and main.ts
 * shows world tooltips (`showAt`) when the pointer rests on an entity or a
 * resource tile (`resourceTooltip`: the ore left there), or on a spot with a
 * mining drill's ghost (`drillAreaTooltip`: the ore in the area it would mine).
 */

import {
  BELT_ITEM_SPACING,
  craftingTicks,
  entityForItem,
  entityPrototype,
  isInserterPrototype,
  type EntityPrototype,
} from '../data/entities';
import { itemPrototype, minedItem } from '../data/items';
import { ORE_IDS } from '../data/resources';
import { CHUNK_SHIFT } from '../sim/world/chunk';
import {
  RECIPE_IDS,
  RECIPES,
  RAW_ITEMS,
  handRecipeFor,
  recipePrototype,
  type Recipe,
  type RecipeStack,
} from '../data/recipes';
import { groupDigits } from './debugOverlay';

/** What a tooltip shows: a title line and detail lines under it. */
export interface TooltipContent {
  title: string;
  lines: string[];
}

const TICKS_PER_SECOND = 60;

/** Seconds of `ticks` ticks, e.g. `0.5 s`, `3.2 s`, `10 s`. */
export function formatSeconds(ticks: number): string {
  const s = ticks / TICKS_PER_SECOND;
  return `${Number.isInteger(s) ? String(s) : s.toFixed(1).replace(/\.0$/, '')} s`;
}

/** Power of `joulesPerTick` J per tick, e.g. `90 kW`, `1.8 MW`, `420 W`. */
export function formatPower(joulesPerTick: number): string {
  const watts = joulesPerTick * TICKS_PER_SECOND;
  const round = (v: number): string => String(Math.round(v * 10) / 10);
  if (watts >= 1_000_000) return `${round(watts / 1_000_000)} MW`;
  if (watts >= 1_000) return `${round(watts / 1_000)} kW`;
  return `${round(watts)} W`;
}

/** Energy of `joules` J, e.g. `4 MJ`. */
function formatEnergy(joules: number): string {
  if (joules >= 1_000_000) return `${String(Math.round(joules / 100_000) / 10)} MJ`;
  return `${String(Math.round(joules / 100) / 10)} kJ`;
}

function stackText([item, count]: RecipeStack): string {
  return `${String(count)} × ${itemPrototype(item)?.label ?? `item#${String(item)}`}`;
}

/** The smelting recipe that makes each item, by item id. */
const SMELTED_FROM = new Map<number, Recipe>();
for (const id of RECIPE_IDS) {
  const recipe = RECIPES[id];
  if (recipe.category === 'smelting') SMELTED_FROM.set(recipe.outputs[0]![0], recipe);
}

/** "Recipe: 5 × Stone → 1 × Stone furnace, 0.5 s" style lines for recipe `recipe`. */
function recipeLines(recipe: Recipe): string[] {
  const made = recipe.outputs.map(stackText).join(', ');
  const from = recipe.inputs.map(stackText).join(', ');
  const where = recipe.category === 'smelting' ? 'in a furnace' : 'by hand or in an assembler';
  return [`${from} → ${made}`, `Crafting time ${formatSeconds(recipe.ticks)} (${where})`];
}

/** What entity `proto` does with power and how fast it works, as tooltip lines. */
export function entityLines(proto: EntityPrototype): string[] {
  const lines: string[] = [`Size ${String(proto.width)}×${String(proto.height)}`];
  const use = proto.energyPerTick;
  if (proto.energySource === 'burner' && use !== undefined) {
    lines.push(`Power ${formatPower(use)}, burns fuel`);
  } else if (proto.energySource === 'electric' && use !== undefined) {
    const drain = proto.drainPerTick ? `, ${formatPower(proto.drainPerTick)} idle` : '';
    lines.push(`Power ${formatPower(use)} electric${drain}`);
  }
  if (proto.maxOutputPerTick !== undefined) {
    lines.push(`Produces up to ${formatPower(proto.maxOutputPerTick)}`);
  }
  if (proto.miningTicks !== undefined) {
    lines.push(`Mines 1 ore every ${formatSeconds(proto.miningTicks)}`);
  }
  if (proto.craftingSpeed) {
    const { num, den } = proto.craftingSpeed;
    lines.push(`Crafting speed ${String(Math.round((num / den) * 100) / 100)}`);
  }
  if (proto.beltSpeed !== undefined) {
    const perSecond = (TICKS_PER_SECOND * proto.beltSpeed * 2) / BELT_ITEM_SPACING;
    lines.push(`Moves ${String(perSecond)} items/s`);
  }
  if (isInserterPrototype(proto) && proto.swingTicks !== undefined) {
    lines.push(`Moves 1 item every ${formatSeconds(2 * proto.swingTicks)}`);
  }
  if (proto.slots !== undefined) lines.push(`${String(proto.slots)} slots`);
  if (proto.wireReach !== undefined && proto.supplyArea !== undefined) {
    lines.push(
      `Wire reach ${String(proto.wireReach)}, supplies ${String(proto.supplyArea)}×${String(proto.supplyArea)}`,
    );
  }
  return lines;
}

/** The tooltip of item `id`: how it is made and, if it places an entity, what that does. */
export function itemTooltip(id: number): TooltipContent | null {
  const proto = itemPrototype(id);
  if (!proto) return null;
  const lines: string[] = [];
  const hand = handRecipeFor(id);
  const smelted = SMELTED_FROM.get(id);
  if (hand) lines.push(...recipeLines(hand));
  else if (smelted) lines.push(...recipeLines(smelted));
  else if (RAW_ITEMS.includes(proto.id)) {
    lines.push(proto.name === 'wood' ? 'Chopped from trees' : 'Mined by hand or by a mining drill');
  }
  if (proto.fuelValue) lines.push(`Fuel value ${formatEnergy(proto.fuelValue)}`);
  const entity = entityForItem(id);
  if (entity) lines.push(...entityLines(entity));
  return { title: proto.label, lines };
}

/**
 * The tooltip of recipe `id`: what it makes, from what, how long it takes
 * (also in machine `machine`, an assembling machine's type id, if given),
 * and what the result does.
 */
export function recipeTooltip(id: number, machine = 0): TooltipContent | null {
  const recipe = recipePrototype(id);
  if (!recipe) return null;
  const output = recipe.outputs[0]![0];
  const lines = recipeLines(recipe);
  const maker = entityPrototype(machine);
  if (maker?.craftingSpeed) {
    lines.push(
      `In ${maker.label}: ${formatSeconds(craftingTicks(recipe.ticks, maker.craftingSpeed))}`,
    );
  }
  const entity = entityForItem(output);
  if (entity) lines.push(...entityLines(entity));
  return { title: itemPrototype(output)?.label ?? `item#${String(output)}`, lines };
}

/**
 * The tooltip of entity type `type`; with `recipe` (an assembling
 * machine's), how long that recipe takes in it.
 */
export function entityTooltip(type: number, recipe = 0): TooltipContent | null {
  const proto = entityPrototype(type);
  if (!proto) return null;
  const lines = entityLines(proto);
  const set = recipePrototype(recipe);
  if (set && proto.craftingSpeed) {
    const made = itemPrototype(set.outputs[0]![0])?.label ?? '?';
    lines.push(`Making ${made}: ${formatSeconds(craftingTicks(set.ticks, proto.craftingSpeed))}`);
  }
  return { title: proto.label, lines };
}

/** The name of resource `resource` (its mined item's), e.g. `Iron ore`. */
function resourceLabel(resource: number): string {
  return itemPrototype(minedItem(resource) ?? 0)?.label ?? `resource#${String(resource)}`;
}

/**
 * The tooltip of a resource tile: the resource and how much is left on it
 * (`amount` units), or `null` for a tile without one.
 */
export function resourceTooltip(resource: number, amount: number): TooltipContent | null {
  if (resource === 0) return null;
  return { title: resourceLabel(resource), lines: [`${groupDigits(amount)} left`] };
}

/** What a tile holds, as far as the main thread knows (`null` before its chunk arrived). */
export type ResourceAt = (x: number, y: number) => { resource: number; amount: number } | null;

/**
 * The ore in the square a mining drill `proto` with its top-left tile at
 * `(x, y)` would mine (`miningArea` centered on it, else its footprint, as
 * the simulation does): the units left per resource id, in id order, only
 * those present. Tiles not received yet count as empty.
 */
export function drillAreaOre(
  proto: EntityPrototype,
  x: number,
  y: number,
  resourceAt: ResourceAt,
): { resource: number; amount: number }[] {
  const size = proto.miningArea ?? proto.width;
  const offset = (proto.width - size) >> 1;
  const totals = new Map<number, number>();
  for (let ty = y + offset; ty < y + offset + size; ty++) {
    for (let tx = x + offset; tx < x + offset + size; tx++) {
      const tile = resourceAt(tx, ty);
      if (tile && tile.resource !== 0 && tile.amount > 0) {
        totals.set(tile.resource, (totals.get(tile.resource) ?? 0) + tile.amount);
      }
    }
  }
  return ORE_IDS.filter((id) => totals.has(id)).map((id) => ({
    resource: id,
    amount: totals.get(id)!,
  }));
}

/**
 * The chunk at chunk coordinates `(cx, cy)` as far as the main thread knows:
 * an object replaced whenever the chunk changes (`null` before it arrived).
 */
export type ChunkAt = (cx: number, cy: number) => object | null;

/**
 * `drillAreaOre` for the spot the pointer rests on, kept until the drill,
 * the spot or a chunk under its area changes (the tooltip asks every frame;
 * the chunks only change when the worker sends them again).
 */
export class DrillAreaOreCache {
  private proto: EntityPrototype | null = null;
  private x = 0;
  private y = 0;
  /** The chunks under the area when `ore` was summed, row by row. */
  private readonly chunks: (object | null)[] = [];
  /** The ore in the area, as `drillAreaOre` returns it. */
  ore: { resource: number; amount: number }[] = [];
  /** The ore as text (`<resource>=<amount>,...`), for the tooltip's key. */
  oreKey = '';

  /** Brings `ore` and `oreKey` up to date for drill `proto` at `(x, y)`. */
  update(
    proto: EntityPrototype,
    x: number,
    y: number,
    resourceAt: ResourceAt,
    chunkAt: ChunkAt,
  ): this {
    const size = proto.miningArea ?? proto.width;
    const offset = (proto.width - size) >> 1;
    const x0 = x + offset;
    const y0 = y + offset;
    let fresh = proto === this.proto && x === this.x && y === this.y;
    let n = 0;
    for (let cy = y0 >> CHUNK_SHIFT; cy <= (y0 + size - 1) >> CHUNK_SHIFT; cy++) {
      for (let cx = x0 >> CHUNK_SHIFT; cx <= (x0 + size - 1) >> CHUNK_SHIFT; cx++) {
        const chunk = chunkAt(cx, cy);
        if (n >= this.chunks.length || this.chunks[n] !== chunk) {
          fresh = false;
          this.chunks[n] = chunk;
        }
        n++;
      }
    }
    this.chunks.length = n;
    if (!fresh) {
      this.proto = proto;
      this.x = x;
      this.y = y;
      this.ore = drillAreaOre(proto, x, y, resourceAt);
      this.oreKey = this.ore.map((o) => `${String(o.resource)}=${String(o.amount)}`).join();
    }
    return this;
  }
}

/**
 * The tooltip of a mining drill's ghost: the ore in the area it would mine
 * (`ore`, from `drillAreaOre`), or that there is none.
 */
export function drillAreaTooltip(
  proto: EntityPrototype,
  ore: readonly { resource: number; amount: number }[],
): TooltipContent {
  const size = proto.miningArea ?? proto.width;
  const area = `${String(size)}×${String(size)}`;
  if (ore.length === 0) return { title: proto.label, lines: [`No ore in its ${area} area`] };
  return {
    title: proto.label,
    lines: [
      `Ore in its ${area} area:`,
      ...ore.map((o) => `${resourceLabel(o.resource)} ${groupDigits(o.amount)}`),
    ],
  };
}

/**
 * The tooltip a `data-tip` value (`item:3`, `recipe:7`, `recipe:7@14` made
 * in machine type 14, `entity:2`) asks for, or `null`.
 */
export function tooltipFor(tip: string): TooltipContent | null {
  const m = /^(item|recipe|entity):(\d+)(?:@(\d+))?$/.exec(tip);
  if (!m || (m[3] !== undefined && m[1] !== 'recipe')) return null;
  const id = Number(m[2]);
  switch (m[1]) {
    case 'item':
      return itemTooltip(id);
    case 'recipe':
      return recipeTooltip(id, Number(m[3] ?? 0));
    default:
      return entityTooltip(id);
  }
}

/** Milliseconds the pointer rests on an element before its tooltip shows. */
const DELAY_MS = 150;
/** Distance of the tooltip from the pointer, in CSS pixels. */
const OFFSET_PX = 14;

/** The tooltip element and the pointer tracking that shows it. */
export class Tooltips {
  readonly element: HTMLElement;
  private anchor: HTMLElement | null = null;
  private shownTip = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private x = 0;
  private y = 0;
  /** Whether a world tooltip (`showAt`) is showing rather than one for an element. */
  private world = false;

  constructor(parent: HTMLElement) {
    const el = document.createElement('div');
    el.id = 'tooltip';
    el.setAttribute('role', 'tooltip');
    el.hidden = true;
    Object.assign(el.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      maxWidth: '300px',
      padding: '6px 9px',
      color: '#e8e2d0',
      font: '12px/1.45 system-ui, sans-serif',
      background: 'rgba(14, 16, 20, 0.95)',
      border: '1px solid rgba(242, 211, 107, 0.45)',
      borderRadius: '5px',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
      pointerEvents: 'none',
      zIndex: '60',
    } satisfies Partial<CSSStyleDeclaration>);
    parent.appendChild(el);
    this.element = el;

    document.addEventListener('pointerover', (e) => {
      const target =
        e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tip]') : null;
      if (target === this.anchor) return;
      this.anchor = target;
      this.world = false;
      this.hide();
      if (target) this.schedule();
    });
    document.addEventListener('pointermove', (e) => {
      this.x = e.clientX;
      this.y = e.clientY;
      if (!this.element.hidden && !this.world) this.place();
    });
    // Windows close on keys (E, Esc) under a resting pointer: check the anchor then.
    window.addEventListener('keyup', () => {
      this.check();
    });
    document.addEventListener('pointerdown', () => {
      // A click changes what a slot shows: show the new tooltip after it.
      queueMicrotask(() => {
        this.check();
      });
    });
  }

  /** Shows the tooltip for the anchor once the pointer rested on it. */
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check();
    }, DELAY_MS);
  }

  /** Shows the anchor's tooltip (or hides it once the anchor is gone or hidden). */
  check(): void {
    if (this.world) return;
    const anchor = this.anchor;
    const tip = anchor?.dataset.tip ?? '';
    if (!anchor?.isConnected || anchor.offsetParent === null || tip === '') {
      this.hide();
      return;
    }
    const content = tooltipFor(tip);
    if (!content) {
      this.hide();
      return;
    }
    if (tip !== this.shownTip || this.element.hidden) this.render(content, tip);
    this.place();
  }

  /** Shows `content` at screen position `(x, y)` (a world entity under the pointer); `null` hides it. */
  showAt(content: TooltipContent | null, key: string, x: number, y: number): void {
    if (this.anchor) return;
    if (!content) {
      if (this.world) {
        this.world = false;
        this.hide();
      }
      return;
    }
    this.world = true;
    this.x = x;
    this.y = y;
    if (key !== this.shownTip || this.element.hidden) this.render(content, key);
    this.place();
  }

  hide(): void {
    this.element.hidden = true;
    this.shownTip = '';
  }

  private render(content: TooltipContent, key: string): void {
    const title = document.createElement('div');
    title.className = 'tooltip-title';
    title.textContent = content.title;
    Object.assign(title.style, { fontWeight: '600', color: '#f2d36b' });
    const lines = content.lines.map((text) => {
      const line = document.createElement('div');
      line.className = 'tooltip-line';
      line.textContent = text;
      return line;
    });
    this.element.replaceChildren(title, ...lines);
    this.element.dataset.tip = key;
    this.shownTip = key;
    this.element.hidden = false;
  }

  /** Puts the tooltip next to the pointer, inside the window. */
  private place(): void {
    const el = this.element;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = this.x + OFFSET_PX;
    let top = this.y + OFFSET_PX;
    if (left + w > window.innerWidth - 4) left = Math.max(4, this.x - OFFSET_PX - w);
    if (top + h > window.innerHeight - 4) top = Math.max(4, this.y - OFFSET_PX - h);
    el.style.transform = `translate(${String(Math.round(left))}px, ${String(Math.round(top))}px)`;
  }
}
