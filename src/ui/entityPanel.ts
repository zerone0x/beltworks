/**
 * The entity GUI (plain DOM): opened by left-clicking a chest, furnace,
 * mining drill or inserter (burner or electric), boiler, steam engine,
 * assembling machine or lab with nothing to build in hand. It shows the entity's slots (and, for a furnace,
 * drill or inserter, its state, smelting or mining progress or arm position,
 * and remaining fuel for burner entities; for a boiler, its state, fuel and
 * output; for a steam engine, its state, output out of its maximum and its
 * network's satisfaction; for an electric drill or inserter, the power it
 * draws out of its maximum and its network's satisfaction) next to the
 * player's inventory:
 * - clicking an inventory stack inserts it into the entity (`Insert`; the
 *   simulation routes fuel to the fuel slot and ores to the input; a drill or
 *   inserter only takes fuel),
 * - clicking one of the entity's slots takes its contents (`Take`).
 *
 * An assembling machine's window also has a recipe picker: one button per
 * recipe the worker says it may make (`recipeOptions` of the detail, from
 * the simulation's `isRecipeUnlocked`), showing the product's icon; a click
 * sends `SetRecipe`, which refunds the machine's contents. Below it, the
 * recipe as text, its input slots, the craft's progress and its output
 * slots (rebuilt whenever the recipe changes), then its power draw.
 *
 * A lab's window shows its science pack slots, the technology of the unit
 * it is researching with that unit's progress, and its power draw.
 *
 * Both ways, a click (or shift-click) moves the whole stack, a right click
 * half of it (rounded up), and a ctrl-click or middle click one item
 * (`transferFor` in inventory.ts).
 * While the cursor holds a stack (D52), a click on the entity's slots puts
 * it into the entity, and a click in the inventory copy puts it in that
 * slot (`dropCursorInto`, `dropCursorOnSlot`).
 *
 * Everything goes through commands, so the panel never changes state itself;
 * it redraws from the `entityDetail` of each snapshot (the worker sends it
 * for the entity named in the last `inspect` message). The panel closes with
 * `Escape` or its close button, and on its own once the entity is gone or out
 * of reach.
 */

import {
  EntityTypeId,
  SAT_ONE,
  craftingTicks,
  entityPrototype,
  isChestPrototype,
  isInserterPrototype,
} from '../data/entities';
import { fuelValue, itemPrototype } from '../data/items';
import { recipePrototype, type Recipe } from '../data/recipes';
import { SCIENCE_PACKS, technologyPrototype } from '../data/technologies';
import { isAssemblerType } from '../sim/entities/assembler';
import { DrillSlot } from '../sim/entities/drill';
import { ElectricDrillSlot } from '../sim/entities/electricDrill';
import { ElectricInserterSlot } from '../sim/entities/electricInserter';
import { FurnaceSlot } from '../sim/entities/furnace';
import { InserterSlot } from '../sim/entities/inserter';
import { MachineState } from '../sim/entities/machine';
import { BoilerSlot } from '../sim/power/boiler';
import type { EntityDetailData, SlotData } from '../sim/snapshot';
import {
  INVENTORY_COLUMNS,
  SLOT_PX,
  SlotGrid,
  makeSlotIcon,
  setSlotIcon,
  transferCount,
  type Transfer,
} from './inventory';

const isDrill = (type: number | undefined): boolean =>
  type === EntityTypeId.BurnerMiningDrill || type === EntityTypeId.ElectricMiningDrill;
const isInserter = (type: number | undefined): boolean =>
  type !== undefined && isInserterPrototype(entityPrototype(type));
const isChest = (type: number): boolean => isChestPrototype(entityPrototype(type));
const isElectric = (type: number): boolean => entityPrototype(type)?.energySource === 'electric';

/** Entity types that have a GUI. */
export function hasEntityGui(type: number): boolean {
  return (
    isChest(type) ||
    type === EntityTypeId.StoneFurnace ||
    isDrill(type) ||
    isInserter(type) ||
    type === EntityTypeId.Boiler ||
    type === EntityTypeId.SteamEngine ||
    isAssemblerType(type) ||
    type === EntityTypeId.Lab
  );
}

/** `ticks` (60 per second) as seconds: `1 s`, `0.67 s`. */
const seconds = (ticks: number): string => `${String(Math.round((ticks / 60) * 100) / 100)} s`;

/**
 * What a recipe button and the recipe line of an assembling machine of type
 * `type` show for recipe `recipe`: the product (its item name, for tests and
 * styling, and label) and the recipe as text, with the time a craft takes
 * in that machine: `2 × Iron plate → Iron gear wheel (1 s)`.
 */
export function recipeView(
  recipe: Recipe,
  type: number,
): { name: string; label: string; text: string } {
  const product = itemPrototype(recipe.outputs[0]![0]);
  const stack = ([item, count]: readonly [number, number]): string => {
    const label = itemPrototype(item)?.label ?? '?';
    return count === 1 ? label : `${String(count)} × ${label}`;
  };
  const ticks = craftingTicks(recipe.ticks, entityPrototype(type)?.craftingSpeed);
  const inputs = recipe.inputs.map(stack).join(' + ');
  const outputs = recipe.outputs.map(stack).join(' + ');
  return {
    name: product?.name ?? '',
    label: product?.label ?? '?',
    text: `${inputs} → ${outputs} (${seconds(ticks)})`,
  };
}

/** Ticks per second: a power of `j` joules per tick is `60 × j` watts. */
const TICKS_PER_SECOND = 60;

/** A power of `joulesPerTick` J/tick as text: `900 kW`, `1.8 MW`, `420 W`. */
export function formatPower(joulesPerTick: number): string {
  const watts = joulesPerTick * TICKS_PER_SECOND;
  const fixed = (v: number): string => String(Math.round(v * 10) / 10);
  if (watts >= 1_000_000) return `${fixed(watts / 1_000_000)} MW`;
  if (watts >= 1_000) return `${fixed(watts / 1_000)} kW`;
  return `${String(watts)} W`;
}

/**
 * What the power section of a boiler's or steam engine's GUI shows: its
 * output this tick as a fraction of its maximum and as text, and (for an
 * engine) its network's satisfaction, or that it isn't connected. For an
 * electric drill or inserter: the power it drew this tick out of what it
 * draws at full power, and its network's satisfaction.
 */
export function powerView(detail: EntityDetailData): {
  output: number;
  text: string;
  network: string;
} {
  const proto = entityPrototype(detail.type);
  const consumer = proto?.energySource === 'electric';
  const max = (consumer ? proto.energyPerTick : proto?.maxOutputPerTick) ?? 0;
  const network =
    detail.type !== EntityTypeId.SteamEngine && !consumer
      ? ''
      : detail.network === 0
        ? 'Not connected'
        : `Network: ${String(Math.floor((detail.satisfaction * 100) / SAT_ONE))}% satisfied`;
  return {
    output: max > 0 ? Math.min(1, detail.power / max) : 0,
    text: `${consumer ? 'Power' : 'Output'}: ${formatPower(detail.power)} / ${formatPower(max)}`,
    network,
  };
}

/** Columns of the chest grid. */
const CHEST_COLUMNS = 8;
/** Columns of an assembling machine's recipe picker. */
const RECIPE_COLUMNS = 8;

/**
 * Display text and a stable key (for tests and styling) per machine state of
 * an entity of type `type`. A working inserter is swinging its arm
 * (`InserterState.Swinging`), and says so.
 */
export function statusView(status: number, type?: number): { key: string; text: string } {
  switch (status) {
    case MachineState.Working:
      return isInserter(type)
        ? { key: 'swinging', text: 'Swinging' }
        : { key: 'working', text: 'Working' };
    case MachineState.NoInput:
      // A steam engine's input is steam from its boiler.
      return type === EntityTypeId.SteamEngine
        ? { key: 'no-steam', text: 'No steam' }
        : { key: 'no-input', text: 'No input' };
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
    case MachineState.NoDemand:
      return { key: 'no-demand', text: 'No demand' };
    case MachineState.NoPower:
      return { key: 'no-power', text: 'No power' };
    case MachineState.LowPower:
      return { key: 'low-power', text: 'Low power' };
    case MachineState.NoRecipe:
      return { key: 'no-recipe', text: 'No recipe' };
    case MachineState.NoResearch:
      return { key: 'no-research', text: 'No research' };
    default:
      return { key: 'idle', text: '' };
  }
}

/**
 * Fractions (0..1) for the progress and fuel bars of a furnace (progress on
 * the recipe being smelted), a mining drill (progress on the unit being
 * mined), an inserter (the arm's position from its pickup to its drop tile)
 * or an assembling machine (progress on the craft, out of the recipe's time
 * at the machine's crafting speed), or a lab (progress on the unit it is
 * researching, out of the technology's ticks per unit).
 */
export function machineBars(detail: EntityDetailData): { progress: number; fuel: number } {
  const proto = entityPrototype(detail.type);
  const recipeTicks = recipePrototype(detail.recipe)?.ticks ?? 0;
  const ticks = isDrill(detail.type)
    ? (proto?.miningTicks ?? 0)
    : isInserter(detail.type)
      ? (proto?.swingTicks ?? 0)
      : detail.type === EntityTypeId.Lab
        ? (technologyPrototype(detail.technology)?.ticksPerUnit ?? 0)
        : craftingTicks(recipeTicks, proto?.craftingSpeed);
  const value = fuelValue(detail.burning);
  return {
    progress: ticks > 0 ? Math.min(1, detail.progress / ticks) : 0,
    fuel: value > 0 ? Math.min(1, detail.energy / value) : 0,
  };
}

export interface EntityPanelOptions {
  /** The player clicked an inventory stack of `item`: insert `count` of it into `entity`. */
  insert: (entity: number, item: number, count: number) => void;
  /** The player clicked slot `slot` of `entity`: take `count` units out of it. */
  take: (entity: number, slot: number, count: number) => void;
  /** The panel opened for `entity`, or closed (0): forward it to the worker (`inspect`). */
  inspect: (entity: number) => void;
  /** The player picked recipe `recipe` for assembling machine `entity` (`SetRecipe`). */
  setRecipe: (entity: number, recipe: number) => void;
  /**
   * A click on one of `entity`'s slots, before it takes anything: returns
   * true if the cursor stack went into the entity instead (D52).
   */
  dropCursorInto?: (entity: number) => boolean;
  /**
   * A click on slot `slot` of the inventory copy, moving `transfer`, before
   * it inserts anything: returns true if it put the cursor stack there instead.
   */
  dropCursorOnSlot?: (slot: number, transfer: Transfer) => boolean;
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
  /** Its entity type. */
  private type = 0;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly body: HTMLElement;
  private readonly inventoryGrid: SlotGrid;
  private inventory: readonly SlotData[] = [];
  private entitySlots: readonly SlotData[] = [];
  private chestGrid: SlotGrid | null = null;
  /**
   * A furnace's, drill's, inserter's or boiler's labeled slots and bars (a
   * boiler has no progress, electric drills and inserters no fuel).
   */
  private machine: { slots: LabeledSlot[]; progress: Bar | null; fuel: Bar | null } | null = null;
  /**
   * The power section: a boiler's or steam engine's output, or an electric
   * drill's or inserter's draw, as a bar and text, and (engines and electric
   * consumers) the network line.
   */
  private power: {
    element: HTMLElement;
    output: Bar;
    text: HTMLElement;
    network: HTMLElement;
  } | null = null;
  /**
   * An assembling machine's recipe picker (rebuilt when the options or the
   * recipe change) and its slots and progress bar (rebuilt when the recipe
   * changes).
   */
  private assembler: {
    picker: HTMLElement;
    options: string;
    recipe: number;
    crafting: HTMLElement;
    info: HTMLElement;
    inputs: SlotGrid | null;
    outputs: SlotGrid | null;
    progress: Bar | null;
  } | null = null;
  /** A lab's pack slots, the technology it researches, and that unit's progress. */
  private lab: { packs: SlotGrid; info: HTMLElement; progress: Bar } | null = null;

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
    this.inventoryGrid = new SlotGrid(inventorySlots, INVENTORY_COLUMNS, (i, transfer) => {
      if (this.options.dropCursorOnSlot?.(i, transfer)) return;
      const stack = this.inventory[i];
      if (this.entityId !== 0 && stack && stack.count > 0) {
        this.options.insert(this.entityId, stack.item, transferCount(stack.count, transfer));
      }
    });
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
  /** Highlights the inventory slot the cursor takes from, or none for `null`. */
  selectInventorySlot(slot: number | null): void {
    this.inventoryGrid.highlight(slot);
  }

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
    // Hovering the name shows the entity's tooltip (power use, size; tooltip.ts).
    this.title.dataset.tip = `entity:${String(type)}`;
    this.type = type;
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
      this.machine.progress?.set(bars.progress);
      this.machine.fuel?.set(bars.fuel);
    }
    if (this.assembler) {
      this.updateAssembler(detail);
    }
    if (this.lab) {
      this.lab.packs.update(detail.slots);
      this.lab.progress.set(machineBars(detail).progress);
      const t = technologyPrototype(detail.technology);
      this.lab.info.textContent = t ? `Researching ${t.label}` : 'Idle: no unit under way';
    }
    if (this.power) {
      const view = powerView(detail);
      this.power.output.set(view.output);
      this.power.text.textContent = view.text;
      this.power.network.textContent = view.network;
    }
  }

  private setStatus(status: number): void {
    const view = statusView(status, this.type);
    this.element.dataset.status = view.key;
    this.status.textContent = view.text;
  }

  private takeSlot(slot: number, transfer: Transfer): void {
    if (this.entityId !== 0 && this.options.dropCursorInto?.(this.entityId)) return;
    const stack = this.entitySlots[slot];
    if (this.entityId !== 0 && stack && stack.count > 0) {
      this.options.take(this.entityId, slot, transferCount(stack.count, transfer));
    }
  }

  private buildBody(type: number): void {
    this.body.replaceChildren();
    this.chestGrid = null;
    this.machine = null;
    this.power = null;
    this.assembler = null;
    this.lab = null;
    if (isAssemblerType(type)) {
      this.buildAssembler();
      return;
    }
    if (type === EntityTypeId.Lab) {
      this.buildLab();
      return;
    }
    if (isChest(type)) {
      const slots = entityPrototype(type)?.slots ?? 0;
      this.chestGrid = new SlotGrid(slots, CHEST_COLUMNS, (i, transfer) => {
        this.takeSlot(i, transfer);
      });
      this.chestGrid.update([]);
      this.body.appendChild(this.chestGrid.element);
      return;
    }
    // Furnace: input and fuel on the left, the progress and fuel bars, the
    // output on the right. Drill: the same without an input (it mines what is
    // under it); the output holds the unit waiting to be dropped. Inserter:
    // fuel, the arm's position, and the item in its hand. Boiler: fuel and
    // its fuel bar, then its output. Steam engine: its output only. Electric
    // drills and inserters have no fuel slot and no fuel bar, and show the
    // power they draw below.
    const boiler = type === EntityTypeId.Boiler;
    const electric = isElectric(type);
    if (boiler || electric || type === EntityTypeId.SteamEngine) {
      this.power = this.buildPower();
    }
    if (type === EntityTypeId.SteamEngine) {
      this.body.appendChild(this.power!.element);
      return;
    }
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
    } satisfies Partial<CSSStyleDeclaration>);
    const labeled = (slot: number, role: string, label: string): LabeledSlot => {
      const grid = new SlotGrid(1, 1, (_, transfer) => {
        this.takeSlot(slot, transfer);
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
    const drill = isDrill(type);
    const inserter = isInserter(type);
    const slots: LabeledSlot[] = [];
    if (!drill && !inserter && !boiler) slots.push(labeled(FurnaceSlot.Input, 'input', 'Input'));
    if (!electric) {
      const fuelSlot = boiler
        ? BoilerSlot.Fuel
        : inserter
          ? InserterSlot.Fuel
          : drill
            ? DrillSlot.Fuel
            : FurnaceSlot.Fuel;
      slots.push(labeled(fuelSlot, 'fuel', 'Fuel'));
    }
    const middle = document.createElement('div');
    Object.assign(middle.style, {
      width: '96px',
      paddingTop: '8px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    } satisfies Partial<CSSStyleDeclaration>);
    const progress = boiler ? null : new Bar('progress', '#f2d36b');
    const fuelBar = electric ? null : new Bar('fuel', '#ff9a2e');
    if (progress) middle.append(progress.element);
    if (fuelBar) middle.append(fuelBar.element);
    row.appendChild(middle);
    if (boiler) {
      this.machine = { slots, progress, fuel: fuelBar };
      this.body.append(row, this.power!.element);
      return;
    }
    if (inserter) {
      const hand = electric ? ElectricInserterSlot.Hand : InserterSlot.Hand;
      slots.push(labeled(hand, 'hand', 'Hand'));
    } else {
      const output = drill
        ? electric
          ? ElectricDrillSlot.Output
          : DrillSlot.Output
        : FurnaceSlot.Output;
      slots.push(labeled(output, 'output', 'Output'));
    }
    this.machine = { slots, progress, fuel: fuelBar };
    this.body.appendChild(row);
    if (this.power) this.body.appendChild(this.power.element);
  }

  /**
   * An assembling machine: the recipe picker, the recipe line, the slots and
   * progress of the recipe set (filled in by `updateAssembler`), and power.
   */
  private buildAssembler(): void {
    const picker = document.createElement('div');
    picker.dataset.role = 'recipes';
    Object.assign(picker.style, {
      display: 'grid',
      gridTemplateColumns: `repeat(${String(RECIPE_COLUMNS)}, ${String(SLOT_PX)}px)`,
      gap: '2px',
      marginBottom: '6px',
    } satisfies Partial<CSSStyleDeclaration>);
    const info = document.createElement('div');
    info.dataset.role = 'recipe';
    Object.assign(info.style, {
      maxWidth: '300px',
      fontSize: '12px',
      color: '#b9b29e',
      marginBottom: '6px',
    } satisfies Partial<CSSStyleDeclaration>);
    const crafting = document.createElement('div');
    Object.assign(crafting.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
    } satisfies Partial<CSSStyleDeclaration>);
    this.power = this.buildPower();
    this.assembler = {
      picker,
      options: '',
      recipe: -1,
      crafting,
      info,
      inputs: null,
      outputs: null,
      progress: null,
    };
    this.body.append(picker, info, crafting, this.power.element);
  }

  /** A lab: its pack slots, the unit it researches with its progress bar, and power. */
  private buildLab(): void {
    const info = document.createElement('div');
    info.dataset.role = 'research';
    Object.assign(info.style, { fontSize: '12px', color: '#b9b29e', marginBottom: '6px' });
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
    } satisfies Partial<CSSStyleDeclaration>);
    const packs = new SlotGrid(SCIENCE_PACKS.length, SCIENCE_PACKS.length, (i, transfer) => {
      this.takeSlot(i, transfer);
    });
    packs.element.dataset.role = 'packs';
    packs.setHints(SCIENCE_PACKS);
    packs.update([]);
    const progress = new Bar('progress', '#f2d36b');
    progress.element.style.width = '96px';
    row.append(packs.element, progress.element);
    this.power = this.buildPower();
    this.lab = { packs, info, progress };
    this.body.append(info, row, this.power.element);
  }

  /** Shows an assembling machine's options, recipe, slots and progress from `detail`. */
  private updateAssembler(detail: EntityDetailData): void {
    const a = this.assembler!;
    const options = detail.recipeOptions.join(',');
    if (options !== a.options || detail.recipe !== a.recipe) {
      a.options = options;
      a.picker.replaceChildren(
        ...detail.recipeOptions.map((id) => this.recipeButton(id, id === detail.recipe)),
      );
    }
    if (detail.recipe !== a.recipe) {
      a.recipe = detail.recipe;
      const r = recipePrototype(detail.recipe);
      a.crafting.replaceChildren();
      a.inputs = a.outputs = a.progress = null;
      a.info.textContent = r ? recipeView(r, this.type).text : 'Pick a recipe.';
      if (r) {
        const inputs = r.inputs.length;
        a.inputs = new SlotGrid(inputs, inputs, (i, transfer) => {
          this.takeSlot(i, transfer);
        });
        a.inputs.element.dataset.role = 'input';
        a.inputs.setHints(r.inputs.map(([item]) => item));
        a.outputs = new SlotGrid(r.outputs.length, r.outputs.length, (j, transfer) => {
          this.takeSlot(inputs + j, transfer);
        });
        a.outputs.element.dataset.role = 'output';
        a.outputs.setHints(r.outputs.map(([item]) => item));
        a.progress = new Bar('progress', '#f2d36b');
        a.progress.element.style.width = '72px';
        a.crafting.append(a.inputs.element, a.progress.element, a.outputs.element);
      }
    }
    if (a.inputs && a.outputs) {
      const inputs = recipePrototype(detail.recipe)?.inputs.length ?? 0;
      a.inputs.update(detail.slots.slice(0, inputs));
      a.outputs.update(detail.slots.slice(inputs));
      a.progress?.set(machineBars(detail).progress);
    }
  }

  /** A button of the recipe picker: the product's icon; a click picks the recipe. */
  private recipeButton(id: number, selected: boolean): HTMLElement {
    const r = recipePrototype(id)!;
    const view = recipeView(r, this.type);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recipe';
    button.dataset.recipe = view.name;
    button.dataset.selected = String(selected);
    // The rich tooltip (tooltip.ts), with the time a craft takes in this machine.
    button.dataset.tip = `recipe:${String(id)}@${String(this.type)}`;
    button.setAttribute('aria-label', `${view.label}: ${view.text}`);
    Object.assign(button.style, {
      position: 'relative',
      boxSizing: 'border-box',
      width: `${String(SLOT_PX)}px`,
      height: `${String(SLOT_PX)}px`,
      padding: '0',
      border: '1px solid rgba(232, 226, 208, 0.25)',
      borderRadius: '3px',
      background: selected ? 'rgba(242, 211, 107, 0.3)' : 'rgba(0, 0, 0, 0.55)',
      outline: selected ? '2px solid #f2d36b' : 'none',
      outlineOffset: '-2px',
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>);
    const icon = makeSlotIcon();
    setSlotIcon(icon, r.outputs[0]![0]);
    button.appendChild(icon);
    button.addEventListener('click', () => {
      if (this.entityId !== 0 && !selected) this.options.setRecipe(this.entityId, id);
    });
    return button;
  }

  /** The power bar, the power text and the network line of a boiler, steam engine or electric consumer. */
  private buildPower(): {
    element: HTMLElement;
    output: Bar;
    text: HTMLElement;
    network: HTMLElement;
  } {
    const element = document.createElement('div');
    element.className = 'power';
    Object.assign(element.style, {
      width: '200px',
      marginTop: '6px',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      fontSize: '12px',
    } satisfies Partial<CSSStyleDeclaration>);
    const output = new Bar('output', '#7ec8ff');
    const text = document.createElement('div');
    text.dataset.role = 'power';
    const network = document.createElement('div');
    network.dataset.role = 'network';
    Object.assign(network.style, { color: '#b9b29e' });
    element.append(output.element, text, network);
    return { element, output, text, network };
  }
}
