/**
 * The entity GUI (plain DOM): opened by left-clicking a chest, furnace,
 * mining drill or inserter with nothing to build in hand. It shows the
 * entity's slots (and, for a furnace, drill or inserter, its state, smelting
 * or mining progress or arm position, and remaining fuel) next to the
 * player's inventory:
 * - clicking an inventory stack inserts it into the entity, right-clicking
 *   inserts half of it, rounded up (`Insert`; the simulation routes fuel to
 *   the fuel slot and ores to the input; a drill or inserter only takes fuel),
 * - clicking one of the entity's slots takes its contents (`Take`).
 *
 * Everything goes through commands, so the panel never changes state itself;
 * it redraws from the `entityDetail` of each snapshot (the worker sends it
 * for the entity named in the last `inspect` message). The panel closes with
 * `Escape` or its close button, and on its own once the entity is gone or out
 * of reach.
 */

import { ENTITIES, EntityTypeId, entityPrototype } from '../data/entities';
import { fuelValue } from '../data/items';
import { recipePrototype } from '../data/recipes';
import { DRILL_MINING_TICKS, DrillSlot } from '../sim/entities/drill';
import { FurnaceSlot } from '../sim/entities/furnace';
import { INSERTER_SWING_TICKS, InserterSlot } from '../sim/entities/inserter';
import { MachineState } from '../sim/entities/machine';
import type { EntityDetailData, SlotData } from '../sim/snapshot';
import { INVENTORY_COLUMNS, SlotGrid } from './inventory';

/** Entity types that have a GUI. */
export function hasEntityGui(type: number): boolean {
  return (
    type === EntityTypeId.WoodenChest ||
    type === EntityTypeId.StoneFurnace ||
    type === EntityTypeId.BurnerMiningDrill ||
    type === EntityTypeId.BurnerInserter
  );
}

/** Columns of the chest grid. */
const CHEST_COLUMNS = 8;

/** Display text and a stable key (for tests and styling) per machine state. */
export function statusView(status: number): { key: string; text: string } {
  switch (status) {
    case MachineState.Working:
      return { key: 'working', text: 'Working' };
    case MachineState.NoInput:
      return { key: 'no-input', text: 'No input' };
    case MachineState.NoFuel:
      return { key: 'no-fuel', text: 'No fuel' };
    case MachineState.OutputFull:
      return { key: 'output-full', text: 'Output full' };
    case MachineState.Depleted:
      return { key: 'depleted', text: 'Depleted' };
    case MachineState.WaitingForSource:
      return { key: 'waiting-for-source', text: 'Waiting for source' };
    case MachineState.WaitingForTarget:
      return { key: 'waiting-for-target', text: 'Waiting for target' };
    default:
      return { key: 'idle', text: '' };
  }
}

/**
 * Fractions (0..1) for the progress and fuel bars of a furnace (progress on
 * the recipe being smelted), a mining drill (progress on the unit being
 * mined) or an inserter (the arm's position from its pickup to its drop tile).
 */
export function machineBars(detail: EntityDetailData): { progress: number; fuel: number } {
  const ticks =
    detail.type === EntityTypeId.BurnerMiningDrill
      ? DRILL_MINING_TICKS
      : detail.type === EntityTypeId.BurnerInserter
        ? INSERTER_SWING_TICKS
        : (recipePrototype(detail.recipe)?.ticks ?? 0);
  const value = fuelValue(detail.burning);
  return {
    progress: ticks > 0 ? Math.min(1, detail.progress / ticks) : 0,
    fuel: value > 0 ? Math.min(1, detail.energy / value) : 0,
  };
}

export interface EntityPanelOptions {
  /** The player clicked inventory slot `[item, count]`: insert it into `entity`. */
  insert: (entity: number, item: number, count: number) => void;
  /** The player clicked slot `slot` of `entity`, which holds `count` units: take them. */
  take: (entity: number, slot: number, count: number) => void;
  /** The panel opened for `entity`, or closed (0): forward it to the worker (`inspect`). */
  inspect: (entity: number) => void;
}

/** A thin horizontal bar showing a fraction. */
class Bar {
  readonly element: HTMLElement;
  private readonly fill: HTMLElement;
  private shown = -1;

  constructor(role: string, color: string) {
    this.element = document.createElement('div');
    this.element.className = 'bar';
    this.element.dataset.role = role;
    Object.assign(this.element.style, {
      width: '100%',
      height: '6px',
      background: 'rgba(0, 0, 0, 0.55)',
      borderRadius: '3px',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    this.fill = document.createElement('div');
    Object.assign(this.fill.style, { height: '100%', width: '0', background: color });
    this.element.appendChild(this.fill);
  }

  set(fraction: number): void {
    const percent = Math.round(fraction * 1000) / 10;
    if (percent === this.shown) return;
    this.shown = percent;
    this.fill.style.width = `${String(percent)}%`;
    this.element.dataset.value = String(percent);
  }
}

/** One labeled machine slot. */
interface LabeledSlot {
  grid: SlotGrid;
  slot: number;
}

export class EntityPanel {
  readonly element: HTMLElement;
  /** The entity shown, or 0 while closed. */
  private entityId = 0;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly body: HTMLElement;
  private readonly inventoryGrid: SlotGrid;
  private inventory: readonly SlotData[] = [];
  private entitySlots: readonly SlotData[] = [];
  private chestGrid: SlotGrid | null = null;
  /** A furnace's, drill's or inserter's labeled slots and bars. */
  private machine: { slots: LabeledSlot[]; progress: Bar; fuel: Bar } | null = null;

  constructor(
    parent: HTMLElement,
    inventorySlots: number,
    private readonly options: EntityPanelOptions,
  ) {
    const el = document.createElement('div');
    el.id = 'entity-panel';
    el.setAttribute('role', 'dialog');
    el.hidden = true;
    Object.assign(el.style, {
      position: 'fixed',
      top: '64px',
      right: '8px',
      padding: '8px',
      color: '#e8e2d0',
      font: '13px/1.4 system-ui, sans-serif',
      background: 'rgba(20, 22, 26, 0.92)',
      border: '1px solid rgba(232, 226, 208, 0.2)',
      borderRadius: '6px',
      zIndex: '20',
    } satisfies Partial<CSSStyleDeclaration>);

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      marginBottom: '6px',
    } satisfies Partial<CSSStyleDeclaration>);
    this.title = document.createElement('div');
    Object.assign(this.title.style, { fontWeight: '600' });
    this.status = document.createElement('div');
    this.status.className = 'status';
    Object.assign(this.status.style, { flex: '1', color: '#b9b29e' });
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Close (Esc)';
    Object.assign(close.style, {
      font: 'inherit',
      color: 'inherit',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '0 2px',
    } satisfies Partial<CSSStyleDeclaration>);
    close.addEventListener('click', () => {
      this.close();
    });
    header.append(this.title, this.status, close);

    this.body = document.createElement('div');
    this.body.className = 'entity-slots';
    Object.assign(this.body.style, { marginBottom: '8px' });

    const invTitle = document.createElement('div');
    invTitle.textContent = 'Inventory';
    Object.assign(invTitle.style, { fontWeight: '600', marginBottom: '4px' });
    const insert = (i: number, half: boolean): void => {
      const stack = this.inventory[i];
      if (this.entityId !== 0 && stack && stack.count > 0) {
        const count = half ? Math.ceil(stack.count / 2) : stack.count;
        this.options.insert(this.entityId, stack.item, count);
      }
    };
    this.inventoryGrid = new SlotGrid(
      inventorySlots,
      INVENTORY_COLUMNS,
      (i) => {
        insert(i, false);
      },
      (i) => {
        insert(i, true);
      },
    );
    this.inventoryGrid.element.classList.add('player-inventory');

    el.append(header, this.body, invTitle, this.inventoryGrid.element);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    parent.appendChild(el);
    this.element = el;
  }

  /** The entity shown, or 0 while closed. */
  get entity(): number {
    return this.entityId;
  }

  get isOpen(): boolean {
    return this.entityId !== 0;
  }

  /** Opens the panel for entity `id` of type `type` (only types with `hasEntityGui`). */
  open(id: number, type: number): void {
    if (!hasEntityGui(type) || id === this.entityId) {
      return;
    }
    this.entityId = id;
    this.element.hidden = false;
    this.element.dataset.entity = String(id);
    this.element.dataset.type = entityPrototype(type)?.name ?? '';
    this.title.textContent = entityPrototype(type)?.label ?? '';
    this.element.setAttribute('aria-label', this.title.textContent);
    this.buildBody(type);
    this.setStatus(MachineState.Idle);
    this.entitySlots = [];
    this.options.inspect(id);
  }

  close(): void {
    if (this.entityId === 0) {
      return;
    }
    this.entityId = 0;
    this.element.hidden = true;
    delete this.element.dataset.entity;
    this.options.inspect(0);
  }

  /**
   * Shows the latest snapshot: `inspected` and `detail` as sent by the worker
   * (closing the panel once its entity is gone or out of reach), and the
   * player's inventory.
   */
  update(inspected: number, detail: EntityDetailData | null, inventory: readonly SlotData[]): void {
    this.inventory = inventory;
    if (this.entityId === 0) {
      return;
    }
    this.inventoryGrid.update(inventory);
    // Snapshots sent before the worker got our `inspect` are about something else.
    if (inspected !== this.entityId) {
      return;
    }
    if (detail?.id !== this.entityId || !detail.reachable) {
      this.close();
      return;
    }
    this.entitySlots = detail.slots;
    this.setStatus(detail.status);
    if (this.chestGrid) {
      this.chestGrid.update(detail.slots);
    }
    if (this.machine) {
      for (const { grid, slot } of this.machine.slots) {
        grid.update([detail.slots[slot] ?? { item: 0, count: 0 }]);
      }
      const bars = machineBars(detail);
      this.machine.progress.set(bars.progress);
      this.machine.fuel.set(bars.fuel);
    }
  }

  private setStatus(status: number): void {
    const view = statusView(status);
    this.element.dataset.status = view.key;
    this.status.textContent = view.text;
  }

  private takeSlot(slot: number): void {
    const stack = this.entitySlots[slot];
    if (this.entityId !== 0 && stack && stack.count > 0) {
      this.options.take(this.entityId, slot, stack.count);
    }
  }

  private buildBody(type: number): void {
    this.body.replaceChildren();
    this.chestGrid = null;
    this.machine = null;
    if (type === EntityTypeId.WoodenChest) {
      const slots = ENTITIES[EntityTypeId.WoodenChest].slots ?? 0;
      this.chestGrid = new SlotGrid(slots, CHEST_COLUMNS, (i) => {
        this.takeSlot(i);
      });
      this.chestGrid.update([]);
      this.body.appendChild(this.chestGrid.element);
      return;
    }
    // Furnace: input and fuel on the left, the progress and fuel bars, the
    // output on the right. Drill: the same without an input (it mines what is
    // under it); the output holds the unit waiting to be dropped. Inserter:
    // fuel, the arm's position, and the item in its hand.
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
    } satisfies Partial<CSSStyleDeclaration>);
    const labeled = (slot: number, role: string, label: string): LabeledSlot => {
      const grid = new SlotGrid(1, 1, () => {
        this.takeSlot(slot);
      });
      grid.element.dataset.role = role;
      grid.update([]);
      const box = document.createElement('div');
      Object.assign(box.style, { textAlign: 'center', fontSize: '11px', color: '#b9b29e' });
      const caption = document.createElement('div');
      caption.textContent = label;
      box.append(grid.element, caption);
      row.appendChild(box);
      return { grid, slot };
    };
    const drill = type === EntityTypeId.BurnerMiningDrill;
    const inserter = type === EntityTypeId.BurnerInserter;
    const slots: LabeledSlot[] = [];
    if (!drill && !inserter) slots.push(labeled(FurnaceSlot.Input, 'input', 'Input'));
    const fuelSlot = inserter ? InserterSlot.Fuel : drill ? DrillSlot.Fuel : FurnaceSlot.Fuel;
    slots.push(labeled(fuelSlot, 'fuel', 'Fuel'));
    const middle = document.createElement('div');
    Object.assign(middle.style, {
      width: '96px',
      paddingTop: '8px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    } satisfies Partial<CSSStyleDeclaration>);
    const progress = new Bar('progress', '#f2d36b');
    const fuelBar = new Bar('fuel', '#ff9a2e');
    middle.append(progress.element, fuelBar.element);
    row.appendChild(middle);
    if (inserter) {
      slots.push(labeled(InserterSlot.Hand, 'hand', 'Hand'));
    } else {
      slots.push(labeled(drill ? DrillSlot.Output : FurnaceSlot.Output, 'output', 'Output'));
    }
    this.machine = { slots, progress, fuel: fuelBar };
    this.body.appendChild(row);
  }
}
