/**
 * Blueprint controls (D59). The copy key (`C` by default) starts a box
 * selection: drag a box with the left mouse button and the entities it
 * touches become the clipboard blueprint, which the cursor then holds. The
 * paste key (`V`) holds the clipboard again, and the library panel can hand
 * any blueprint to `hold`. While a blueprint is held its ghosts follow the
 * cursor (green where an entity would be placed, red where it would be
 * skipped), `R` turns the whole blueprint, and a left click pastes it as
 * ordinary `Place` / `Rotate` commands (then `SetRecipe` once the machines
 * show up in a snapshot). `Q`, a right click or `Escape` put it away.
 *
 * While it is active the blueprint input takes the left and right mouse
 * buttons on the canvas and the rotate and pipette keys before the build and
 * player inputs see them (capture-phase listeners that stop the event), so
 * nothing is placed, removed or mined by accident.
 */

import type { EntityPrototype } from '../data/entities';
import { itemPrototype } from '../data/items';
import {
  blueprintOrigin,
  boxOf,
  captureBlueprint,
  planPaste,
  rotateBlueprint,
  type Blueprint,
  type PastePlan,
  type PendingRecipe,
  type TileBox,
} from '../blueprint/blueprint';
import { UndergroundMode, type UndergroundInfo } from '../sim/belts/underground';
import type { CommandInput } from '../sim/commands';
import type { Direction } from '../sim/entities/direction';
import type { SlotData } from '../sim/snapshot';
import { actionFor } from '../ui/keybindings';
import { TILE_PX, type Point } from './camera';
import type { EntityView } from './entityIndex';
import type { Ghost } from './entityLayer';

const LEFT_BUTTON = 0;
const RIGHT_BUTTON = 2;
/** Snapshots a pasted machine has to show up in before its recipe is given up on. */
const RECIPE_WAIT_SNAPSHOTS = 180;

export type BlueprintMode = 'idle' | 'select' | 'paste';

export interface BlueprintInputOptions {
  /** The game canvas. */
  element: HTMLElement;
  playerId: number;
  send: (commands: CommandInput[]) => void;
  /** Pointer position over the canvas in CSS pixels, or `null` when it is elsewhere. */
  pointer: () => Point | null;
  /** World position (world pixels) under a screen position. */
  screenToWorld: (sx: number, sy: number) => Point;
  /** The entities around the view, as the renderer knows them. */
  entities: () => Iterable<EntityView>;
  /** The entity covering tile `(x, y)`, as the renderer knows it. */
  entityAt: (x: number, y: number) => EntityView | null;
  /** The underground belt on a tile, as the renderer knows it. */
  undergroundAt: (x: number, y: number) => UndergroundInfo | null;
  /** Whether `proto` can be placed there, as far as the renderer can tell. */
  canPlace: (proto: EntityPrototype, x: number, y: number, dir: Direction) => boolean;
  /** The local player's inventory as last received. */
  inventory: () => readonly SlotData[];
  /** A selection starts or a blueprint is picked up: put away whatever the cursor holds. */
  onActivate?: () => void;
  /** A box selection made a new clipboard blueprint. */
  onCopied?: (bp: Blueprint) => void;
  /** Shows a short message to the player. */
  notify: (message: string) => void;
}

/** A short "what was skipped" message for a paste, or `null` when everything was placed. */
export function pasteMessage(plan: PastePlan): string | null {
  const total = plan.entities.length;
  if (plan.placed === total) return null;
  const parts: string[] = [];
  if (plan.missing.size > 0) {
    const items = [...plan.missing].map(
      ([item, n]) => `${String(n)} × ${itemPrototype(item)?.label ?? `item#${String(item)}`}`,
    );
    parts.push(`missing ${items.join(', ')}`);
  }
  if (plan.blocked > 0) {
    parts.push(`${String(plan.blocked)} blocked (in the way, on water or out of reach)`);
  }
  return `Pasted ${String(plan.placed)} of ${String(total)}: ${parts.join('; ')}.`;
}

export class BlueprintInput {
  mode: BlueprintMode = 'idle';
  /** The last blueprint copied (or imported and pasted). */
  clipboard: Blueprint | null = null;
  /** The blueprint on the cursor (in `paste` mode). */
  held: Blueprint | null = null;
  /** The selection box (in `select` mode): the tile under the pointer, or the box being dragged. */
  box: TileBox | null = null;
  /** The held blueprint's ghosts after the latest `update()` (`null` when none is held). */
  ghosts: Ghost[] | null = null;
  /** The plan behind `ghosts`. */
  plan: PastePlan | null = null;
  private planKey = '';
  /** Set when a snapshot arrived (or a paste was sent) since the last plan. */
  private stale = false;
  private dragStart: Point | null = null;
  private released = false;
  private clickPending = false;
  private rotateRequested = false;
  private pending: (PendingRecipe & { wait: number })[] = [];
  private readonly controller = new AbortController();

  constructor(private readonly options: BlueprintInputOptions) {
    const capture = { signal: this.controller.signal, capture: true };
    window.addEventListener('pointerdown', this.onPointerDown, capture);
    window.addEventListener('pointerup', this.onPointerUp, capture);
    window.addEventListener('keydown', this.onKeyDown, capture);
  }

  /** Whether a selection or a held blueprint takes the mouse. */
  get active(): boolean {
    return this.mode !== 'idle';
  }

  /** Starts a box selection. */
  startCopy(): void {
    this.clear();
    this.mode = 'select';
    this.options.onActivate?.();
  }

  /** Puts `bp` on the cursor. */
  hold(bp: Blueprint): void {
    this.clear();
    this.held = bp;
    this.mode = 'paste';
    this.options.onActivate?.();
  }

  /** Ends a selection or puts the held blueprint away. */
  clear(): void {
    this.mode = 'idle';
    this.held = null;
    this.box = null;
    this.ghosts = null;
    this.plan = null;
    this.planKey = '';
    this.dragStart = null;
    this.released = false;
    this.clickPending = false;
    this.rotateRequested = false;
  }

  /** The tile under the pointer, or `null`. */
  private pointerTile(): Point | null {
    const p = this.options.pointer();
    if (!p) return null;
    const w = this.options.screenToWorld(p.x, p.y);
    return { x: Math.floor(w.x / TILE_PX), y: Math.floor(w.y / TILE_PX) };
  }

  /** Updates the selection or the ghosts and pastes on a click. Call once per frame, after the camera moved. */
  update(): void {
    if (this.mode === 'select') this.updateSelection();
    else if (this.mode === 'paste') this.updatePaste();
  }

  private updateSelection(): void {
    const tile = this.pointerTile();
    if (this.dragStart && tile) this.box = boxOf(this.dragStart, tile);
    else if (!this.dragStart) this.box = tile && boxOf(tile, tile);
    if (!this.released) return;
    const box = this.box;
    this.released = false;
    this.dragStart = null;
    const { options } = this;
    const bp =
      box &&
      captureBlueprint(
        options.entities(),
        box,
        (x, y) => options.undergroundAt(x, y)?.mode ?? UndergroundMode.None,
      );
    if (!bp) {
      options.notify('Nothing to copy there: drag a box over some buildings.');
      this.clear();
      return;
    }
    this.clipboard = bp;
    options.onCopied?.(bp);
    this.hold(bp);
  }

  private updatePaste(): void {
    const { options } = this;
    if (this.rotateRequested && this.held) {
      this.held = rotateBlueprint(this.held);
      this.planKey = '';
    }
    this.rotateRequested = false;
    const clicked = this.clickPending;
    this.clickPending = false;
    const bp = this.held;
    const p = options.pointer();
    if (!bp || !p) {
      this.ghosts = null;
      return;
    }
    const w = options.screenToWorld(p.x, p.y);
    const { x, y } = blueprintOrigin(bp, w.x / TILE_PX, w.y / TILE_PX);
    const inventory = options.inventory();
    // Re-plan when the spot, the blueprint, the inventory or the world (a new snapshot) changed.
    const key = `${String(x)},${String(y)}`;
    if (!this.plan || key !== this.planKey || clicked || this.stale) {
      const counts = new Map<number, number>();
      for (const s of inventory) {
        if (s.count > 0) counts.set(s.item, (counts.get(s.item) ?? 0) + s.count);
      }
      this.plan = planPaste(
        bp,
        x,
        y,
        {
          canPlace: options.canPlace,
          count: (item) => counts.get(item) ?? 0,
          undergroundAt: options.undergroundAt,
        },
        options.playerId,
      );
      this.planKey = key;
      this.stale = false;
      this.ghosts = this.plan.entities.map((e) => ({
        proto: e.proto,
        x: e.x,
        y: e.y,
        dir: e.dir,
        valid: e.skip === null,
        ...(e.mode !== UndergroundMode.None && { mode: e.mode }),
      }));
    }
    if (!clicked) return;
    const plan = this.plan;
    if (plan.commands.length > 0) options.send([...plan.commands]);
    for (const r of plan.recipes) this.pending.push({ ...r, wait: RECIPE_WAIT_SNAPSHOTS });
    const message = pasteMessage(plan);
    if (message) options.notify(message);
    // The world changes with the paste: plan again from the next snapshot.
    this.stale = true;
  }

  /**
   * A snapshot arrived: plan the ghosts again, and set the recipes of pasted
   * machines that showed up (their ids are known now).
   */
  onSnapshot(): void {
    this.stale = true;
    if (this.pending.length === 0) return;
    const commands: CommandInput[] = [];
    this.pending = this.pending.filter((r) => {
      const e = this.options.entityAt(r.x, r.y);
      if (e && e.type === r.type && e.x === r.x && e.y === r.y) {
        if (e.recipe !== r.recipe) {
          commands.push({
            type: 'SetRecipe',
            playerId: this.options.playerId,
            entity: e.id,
            recipe: r.recipe,
          });
        }
        return false;
      }
      return --r.wait > 0;
    });
    if (commands.length > 0) this.options.send(commands);
  }

  destroy(): void {
    this.controller.abort();
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.active || e.target !== this.options.element) return;
    if (e.button === RIGHT_BUTTON) {
      this.clear();
    } else if (e.button === LEFT_BUTTON) {
      if (this.mode === 'select') {
        this.dragStart = this.pointerTile();
        this.released = false;
      } else {
        this.clickPending = true;
      }
    } else {
      return;
    }
    // The build and player inputs must not place, remove or mine with this press.
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.button === LEFT_BUTTON && this.mode === 'select' && this.dragStart) {
      this.released = true;
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }
    if (e.key === 'Escape') {
      // The game menu already saw that something was open (main.ts) and stayed shut.
      if (this.active) this.clear();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const action = actionFor(e.code);
    let handled = true;
    if (action === 'copy') {
      if (!e.repeat) {
        if (this.mode === 'select') this.clear();
        else this.startCopy();
      }
    } else if (action === 'paste') {
      if (!e.repeat) {
        if (this.clipboard) this.hold(this.clipboard);
        else this.options.notify('Nothing copied yet: press the copy key and drag a box.');
      }
    } else if (action === 'rotate' && this.mode === 'paste') {
      if (!e.repeat) this.rotateRequested = true;
    } else if (action === 'pipette' && this.active) {
      if (!e.repeat) this.clear();
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
}
