/**
 * Crafting UI (plain DOM):
 * - the crafting panel, a section of the inventory window listing every hand
 *   recipe with how many crafts the inventory allows (click crafts 1,
 *   shift-click crafts 5);
 * - the queue strip above the hotbar, showing the crafting queue with the
 *   front craft's progress (click an entry to cancel it).
 *
 * Both only send `Craft` / `CancelCraft` commands; the simulation decides
 * what happens. Craftable counts come from the same planner the simulation
 * uses (src/sim/crafting/plan.ts), applied to the latest snapshot. Recipes
 * the force hasn't unlocked yet (the snapshot's research) are hidden.
 */

import { itemPrototype } from '../data/items';
import { HAND_RECIPES, recipePrototype, type Recipe } from '../data/recipes';
import type { CommandInput } from '../sim/commands';
import { countItems, maxCraftable } from '../sim/crafting/plan';
import { CRAFT_QUEUE_LENGTH, CraftFlag } from '../sim/crafting/queue';
import {
  NO_RESEARCH,
  researchUnlocks,
  type CraftQueueData,
  type ResearchData,
  type SlotData,
} from '../sim/snapshot';
import {
  GAP_PX,
  HOTBAR_BOTTOM_PX,
  HOTBAR_SLOTS,
  MARKED_GLOW,
  SLOT_PX,
  barWidth,
  makeSlotIcon,
  setSlotIcon,
} from './inventory';

/** Crafts queued by a shift-click. */
export const SHIFT_CRAFT_COUNT = 5;
/** Columns of the recipe grid. */
const RECIPE_COLUMNS = 3;
const SLOT_BORDER = '1px solid rgba(232, 226, 208, 0.25)';
const COUNT_FONT = '11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace';

/** The item a recipe is shown as: its first output. */
function shownItem(recipe: Recipe) {
  return itemPrototype(recipe.outputs[0]![0])!;
}

/** Internal name of a recipe for the UI and tests: the name of its first output, e.g. `stone-furnace`. */
export function recipeName(recipe: Recipe): string {
  return shownItem(recipe).name;
}

/** Tooltip of a recipe: what it makes, from what, and how long it takes. */
export function recipeTitle(recipe: Recipe): string {
  const stack = ([item, count]: readonly [number, number]) =>
    `${String(count)} × ${itemPrototype(item)?.label ?? `item#${String(item)}`}`;
  const seconds = (recipe.ticks / 60).toFixed(1);
  return `${recipe.outputs.map(stack).join(', ')} ← ${recipe.inputs.map(stack).join(', ')} (${seconds} s)`;
}

/**
 * How many crafts of each hand recipe the player can queue now, in
 * `HAND_RECIPES` order (0 for recipes `research` hasn't unlocked).
 */
export function craftableCounts(
  slots: readonly SlotData[],
  queueLength: number,
  research: ResearchData = NO_RESEARCH,
): number[] {
  const available = countItems(
    slots.map((s) => s.item),
    slots.map((s) => s.count),
  );
  const free = CRAFT_QUEUE_LENGTH - queueLength;
  const unlocked = (r: number): boolean => researchUnlocks(research, r);
  return HAND_RECIPES.map((r) => maxCraftable(r, available, free, undefined, unlocked));
}

/** A slot-sized square with an item icon and a count, like the inventory slots. */
function makeSlot(tag: 'button' | 'div'): {
  root: HTMLElement;
  icon: HTMLElement;
  count: HTMLElement;
} {
  const root = document.createElement(tag);
  Object.assign(root.style, {
    position: 'relative',
    boxSizing: 'border-box',
    width: `${String(SLOT_PX)}px`,
    height: `${String(SLOT_PX)}px`,
    padding: '0',
    border: SLOT_BORDER,
    borderRadius: '3px',
    background: 'rgba(0, 0, 0, 0.55)',
    cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>);
  const icon = makeSlotIcon();
  const count = document.createElement('span');
  count.className = 'count';
  Object.assign(count.style, {
    position: 'absolute',
    right: '2px',
    bottom: '0',
    font: COUNT_FONT,
    color: '#f4efe0',
    textShadow: '0 0 2px #000, 0 0 2px #000',
  } satisfies Partial<CSSStyleDeclaration>);
  root.append(icon, count);
  // Clicking must not focus the button, or Space/Enter would click it again.
  root.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });
  return { root, icon, count };
}

export interface CraftingUiOptions {
  playerId: number;
  send: (commands: CommandInput[]) => void;
}

/** The recipe list inside the inventory window. */
export class CraftingPanel {
  readonly element: HTMLElement;
  private readonly cells: { root: HTMLElement; count: HTMLElement }[] = [];
  private shown = '';
  private marked = 0;

  constructor({ playerId, send }: CraftingUiOptions) {
    const el = document.createElement('div');
    el.id = 'crafting-panel';
    const title = document.createElement('div');
    title.textContent = 'Crafting';
    Object.assign(title.style, { fontWeight: '600', marginBottom: '6px' });
    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: `repeat(${String(RECIPE_COLUMNS)}, ${String(SLOT_PX)}px)`,
      gap: `${String(GAP_PX)}px`,
    } satisfies Partial<CSSStyleDeclaration>);
    for (const recipe of HAND_RECIPES) {
      const { root, icon, count } = makeSlot('button');
      root.className = 'recipe';
      root.dataset.recipe = recipeName(recipe);
      root.setAttribute('aria-label', `${shownItem(recipe).label}: ${recipeTitle(recipe)}`);
      root.dataset.tip = `recipe:${String(recipe.id)}`;
      setSlotIcon(icon, shownItem(recipe).id);
      root.addEventListener('click', (e) => {
        send([
          {
            playerId,
            type: 'Craft',
            recipe: recipe.id,
            count: e.shiftKey ? SHIFT_CRAFT_COUNT : 1,
          },
        ]);
      });
      grid.appendChild(root);
      this.cells.push({ root, count });
    }
    el.append(title, grid);
    this.element = el;
    this.update([], 0);
  }

  /** Points out the button of hand recipe `recipe` with a glow (the onboarding); 0 for none. */
  markRecipe(recipe: number): void {
    if (recipe === this.marked) return;
    this.marked = recipe;
    HAND_RECIPES.forEach((r, i) => {
      const cell = this.cells[i]!;
      const on = r.id === recipe;
      cell.root.dataset.marked = String(on);
      cell.root.style.boxShadow = on ? MARKED_GLOW : 'none';
    });
  }

  /**
   * Shows the craftable counts for `slots` with a queue of `queueLength`
   * entries, and only the recipes `research` has unlocked.
   */
  update(
    slots: readonly SlotData[],
    queueLength: number,
    research: ResearchData = NO_RESEARCH,
  ): void {
    const counts = craftableCounts(slots, queueLength, research);
    const locked = HAND_RECIPES.map((r) => !researchUnlocks(research, r.id));
    const key = `${counts.join(',')}|${locked.join(',')}`;
    if (key === this.shown) {
      return;
    }
    this.shown = key;
    counts.forEach((n, i) => {
      const cell = this.cells[i]!;
      cell.root.dataset.locked = String(locked[i]);
      cell.root.style.display = locked[i] ? 'none' : '';
      cell.root.dataset.craftable = String(n);
      cell.count.textContent = n > 0 ? String(n) : '';
      // Dim what can't be crafted, without hiding it.
      cell.root.style.opacity = n > 0 ? '1' : '0.45';
    });
  }
}

/** The crafting queue strip above the hotbar; hidden while the queue is empty. */
export class CraftQueueStrip {
  readonly element: HTMLElement;
  private readonly cells: {
    root: HTMLElement;
    icon: HTMLElement;
    count: HTMLElement;
    bar: HTMLElement;
  }[] = [];
  private shown = '';

  constructor(parent: HTMLElement, { playerId, send }: CraftingUiOptions) {
    const hotbarWidth = barWidth(HOTBAR_SLOTS);
    const el = document.createElement('div');
    el.id = 'craft-queue';
    el.hidden = true;
    Object.assign(el.style, {
      position: 'fixed',
      // Just above the hotbar, lined up with its left edge.
      bottom: `${String(HOTBAR_BOTTOM_PX + barWidth(1) + 6)}px`,
      left: '50%',
      marginLeft: `${String(-Math.round(hotbarWidth / 2))}px`,
      maxWidth: `${String(hotbarWidth)}px`,
      padding: '4px',
      background: 'rgba(0, 0, 0, 0.45)',
      borderRadius: '4px',
      zIndex: '10',
    } satisfies Partial<CSSStyleDeclaration>);
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      flexWrap: 'wrap',
      gap: `${String(GAP_PX)}px`,
    } satisfies Partial<CSSStyleDeclaration>);
    for (let i = 0; i < CRAFT_QUEUE_LENGTH; i++) {
      const { root, icon, count } = makeSlot('button');
      root.className = 'craft';
      root.dataset.index = String(i);
      root.style.display = 'none';
      const bar = document.createElement('div');
      Object.assign(bar.style, {
        position: 'absolute',
        left: '2px',
        bottom: '2px',
        height: '3px',
        width: '0',
        background: '#f2d36b',
      } satisfies Partial<CSSStyleDeclaration>);
      root.appendChild(bar);
      root.addEventListener('click', () => {
        send([{ playerId, type: 'CancelCraft', index: i }]);
      });
      row.appendChild(root);
      this.cells.push({ root, icon, count, bar });
    }
    el.appendChild(row);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
    parent.appendChild(el);
    this.element = el;
  }

  update(queue: CraftQueueData): void {
    const front = queue.entries[0];
    const frontRecipe = front && recipePrototype(front.recipe);
    // Progress as a whole number of pixels, so the strip only changes when the bar does.
    const barMax = SLOT_PX - 6;
    const bar = frontRecipe
      ? Math.min(barMax, Math.floor((queue.progress * barMax) / frontRecipe.ticks))
      : 0;
    const key = `${String(bar)}|${queue.entries.map((e) => `${String(e.recipe)}:${String(e.crafts)}:${String(e.flags)}`).join(',')}`;
    if (key === this.shown) {
      return;
    }
    this.shown = key;
    this.element.hidden = queue.entries.length === 0;
    this.element.dataset.progress = String(queue.progress);
    this.cells.forEach((cell, i) => {
      const entry = queue.entries[i];
      const recipe = entry && recipePrototype(entry.recipe);
      if (!entry || !recipe) {
        cell.root.style.display = 'none';
        delete cell.root.dataset.recipe;
        return;
      }
      const item = shownItem(recipe);
      const units = entry.crafts * recipe.outputs[0]![1];
      const intermediate = (entry.flags & CraftFlag.Intermediate) !== 0;
      cell.root.style.display = 'block';
      cell.root.dataset.recipe = recipeName(recipe);
      cell.root.dataset.count = String(units);
      cell.root.dataset.intermediate = String(intermediate);
      cell.root.title = `${item.label} × ${String(units)}${intermediate ? ' (intermediate)' : ''} — click to cancel`;
      setSlotIcon(cell.icon, item.id);
      // Intermediates are drawn smaller: they are made for the next entry.
      cell.icon.style.transform = intermediate ? 'scale(0.7)' : 'none';
      cell.count.textContent = String(units);
      cell.bar.style.width = `${String(i === 0 ? bar : 0)}px`;
    });
  }
}
