/**
 * Test-only hook exposed as `window.__beltworks` in dev and test builds
 * (`vite` or `vite build --mode test`). main.ts loads this module through a
 * dynamic import behind a compile-time check, so production builds don't
 * contain it.
 */

import { EntityTypeId } from './data/entities';
import { ITEM_IDS, ITEMS, MAX_STACK_SIZE, type ItemStack } from './data/items';
import type { BuildInput } from './render/buildInput';
import { ghostDrillDropTile, ghostInserterTiles } from './render/entityLayer';
import { TILE_PX } from './render/camera';
import type { GameView } from './render/gameView';
import type { TerrainStats, TileInfo } from './render/terrainLayer';
import type { EntityPanel } from './ui/entityPanel';
import type { PowerPanel } from './ui/powerPanel';
import { SUBTILES_PER_TILE } from './sim/fixed';
import { runDeterminismScenario, type DeterminismResult } from './sim/scenarios/determinism';
import {
  decodeCraftQueue,
  PlayerField,
  PLAYER_STRIDE,
  type CraftQueueData,
  type PowerData,
  type SlotData,
} from './sim/snapshot';
import { World } from './sim/world/world';
import { chunkWindow } from './worker/chunkStream';
import type { SimClient } from './worker/client';
import { LOCAL_PLAYER_ID, type ChunkRect } from './worker/protocol';

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

/** The local player as of the latest snapshot. */
export interface PlayerState {
  /** Position in tiles (fractional). */
  x: number;
  y: number;
  mining: boolean;
  mineX: number;
  mineY: number;
  /** Ticks into the current unit. */
  mineProgress: number;
}

/** An entity as known to the renderer. */
export interface EntityState {
  id: number;
  /** Prototype name, e.g. `wooden-chest`. */
  name: string;
  /** Top-left tile and footprint size. */
  x: number;
  y: number;
  w: number;
  h: number;
  dir: number;
  /** Machine state (`MachineState`), e.g. 1 while a furnace works. */
  status: number;
  /** The recipe an assembling machine is set to (0 for none and other types). */
  recipe: number;
}

/** A belt as known to the renderer, with the items on it. */
export interface BeltState {
  x: number;
  y: number;
  dir: number;
  /** `BeltShape`: 0 straight, 1 and 2 curves. */
  shape: number;
  /** Items: lane (0 left, 1 right), distance from the belt's end edge in subtiles, item id. */
  items: { lane: number; offset: number; item: number }[];
}

/** An inserter as known to the renderer. */
export interface InserterView {
  x: number;
  y: number;
  dir: number;
  /**
   * Arm position: 0 at the pickup tile, `span` at the drop tile (in ticks for
   * burner inserters, 1/65536 ticks for electric ones).
   */
  arm: number;
  /** The item in the hand, or 0. */
  held: number;
  /** How the arm moved on the last tick, in arm units: positive out, negative back, 0 not at all. */
  swing: number;
  /** Arm position at the drop tile. */
  span: number;
  /** Entity type id. */
  type: number;
}

/** The power overlay, as last drawn. */
export interface PowerFocusState {
  /** `ghost` for a pole about to be placed, `pole` for a placed pole under the pointer. */
  kind: 'ghost' | 'pole';
  name: string;
  x: number;
  y: number;
  /** Poles it is (or would be) wired to. */
  connects: number[];
}

/** The ghost preview, as last drawn. */
export interface GhostState {
  name: string;
  x: number;
  y: number;
  dir: number;
  valid: boolean;
  /** For an inserter: the tiles it would pick up from and drop onto; for a mining drill, the tile it would drop onto. */
  pickup?: { x: number; y: number };
  drop?: { x: number; y: number };
}

export interface BeltworksTestHook {
  /** Runs the determinism scenario synchronously on the main thread. */
  runDeterminism(ticks?: number): DeterminismResult;
  /** Tick of the latest snapshot from the worker, or -1 before the first one. */
  latestTick(): number;
  /** Current camera position (world pixels at the screen center) and zoom. */
  camera(): CameraState;
  /** Moves the camera, as if the player had panned and zoomed there (this stops following the player). */
  setCamera(x: number, y: number, zoom?: number): void;
  /** Whether the camera follows the local player. */
  following(): boolean;
  /** The local player from the latest snapshot, or `null` before the first one. */
  player(): PlayerState | null;
  /** The local player's inventory from the latest snapshot. */
  inventory(): SlotData[];
  /** The local player's crafting queue from the latest snapshot (empty before the first one). */
  craftQueue(): CraftQueueData;
  /** Screen position (CSS pixels) of the center of tile `(x, y)`. */
  tileToScreen(x: number, y: number): { x: number; y: number };
  /** The tile as cached by the renderer from the worker's chunks, or `null` if not loaded. */
  renderedTile(x: number, y: number): TileInfo | null;
  /** Tile under screen position `(sx, sy)` (CSS pixels). */
  tileAtScreen(sx: number, sy: number): { x: number; y: number };
  /** Chunk cache and sprite counts of the terrain layer. */
  terrainStats(): TerrainStats;
  /** True once every chunk around the current view has arrived and been baked. */
  terrainReady(): boolean;
  /** The tile as generated by a main-thread `World` with the game's seed, for cross-checks. */
  generatedTile(x: number, y: number): TileInfo;
  /** Entities around the view from the latest snapshot. */
  entities(): EntityState[];
  /** Belts around the view and their items, from the latest snapshot. */
  belts(): BeltState[];
  /** Inserters around the view with their arm and hand, from the latest snapshot. */
  inserters(): InserterView[];
  /**
   * Drops `count` of `item` from the local player's inventory onto the belt
   * on tile `(x, y)` (an `Insert` command, as a hand would; at most one per
   * lane goes on at a time). Returns false if the renderer knows no belt there.
   */
  dropOnBelt(x: number, y: number, item: number, count?: number): boolean;
  /** Electric poles around the view with their networks, the wires between them, and the networks. */
  power(): PowerData;
  /** Steam engines around the view: flywheel speed (0..1, output over maximum) and angle (turns). */
  generators(): { id: number; speed: number; phase: number }[];
  /** The pole whose supply area and wire reach the overlay shows, or `null`. */
  powerFocus(): PowerFocusState | null;
  /** The ghost preview, or `null` when none is shown. */
  ghost(): GhostState | null;
  /** The inventory slot selected for building (0–9 are the hotbar), or `null`. */
  selectedSlot(): number | null;
  /** The entity whose GUI is open, or 0. */
  openEntity(): number;
  /** The pole whose power panel is open, or 0. */
  openPowerPanel(): number;
  /** Power icons (no power, low power) the entity layer drew last. */
  powerIcons(): number;
  /** Assembling machines as drawn last: the product icon shown (0 for none) and animation speed (0..1). */
  assemblers(): { id: number; item: number; speed: number }[];
  /**
   * Pre-rendered sprites: the models of the loaded atlas (empty until it
   * loads), the entities drawn with sprites and how many of them animate,
   * and whether the ghost shows a sprite.
   */
  sprites(): { models: string[]; entities: number; animated: number; ghost: boolean };
}

declare global {
  interface Window {
    __beltworks?: BeltworksTestHook;
  }
}

const ITEM_BY_NAME = new Map(ITEM_IDS.map((id) => [ITEMS[id].name, id]));

/**
 * The starting kit asked for by a `kit` URL parameter (dev and test builds
 * only), replacing the default kit: comma-separated `name:count` pairs in
 * hotbar order, e.g. `?kit=electric-mining-drill:16,coal:20`. For end-to-end
 * tests that need more than the default kit has (docs/DECISIONS.md, D29).
 * `undefined` without the parameter; throws on an unknown item or a bad count.
 */
export function startingKitFromUrl(search: string): ItemStack[] | undefined {
  const param = new URLSearchParams(search).get('kit');
  if (param === null) return undefined;
  return param
    .split(',')
    .filter((part) => part !== '')
    .map((part) => {
      const [name = '', countText = ''] = part.split(':');
      const item = ITEM_BY_NAME.get(name);
      const count = Number(countText);
      if (item === undefined || !Number.isInteger(count) || count < 1 || count > MAX_STACK_SIZE) {
        throw new Error(`bad kit entry "${part}"`);
      }
      return { item, count };
    });
}

export interface TestHookContext {
  client: SimClient;
  view: GameView;
  build: BuildInput;
  entityPanel: EntityPanel;
  powerPanel: PowerPanel;
  /** The world seed the game runs with. */
  seed: number;
  /** The local player's inventory as last shown by the UI. */
  inventory: () => SlotData[];
}

export function installTestHook({
  client,
  view,
  build,
  entityPanel,
  powerPanel,
  seed,
  inventory,
}: TestHookContext): void {
  let world: World | null = null;
  window.__beltworks = {
    runDeterminism: (ticks) => runDeterminismScenario(ticks),
    latestTick: () => client.latestSnapshot?.tick ?? -1,
    camera: () => ({ x: view.camera.x, y: view.camera.y, zoom: view.camera.zoom }),
    setCamera: (x, y, zoom) => {
      view.following = false;
      view.camera.set(x, y, zoom);
    },
    following: () => view.following,
    player: () => {
      const records = view.track.latest;
      const o = LOCAL_PLAYER_ID * PLAYER_STRIDE;
      if (records.length < o + PLAYER_STRIDE) {
        return null;
      }
      return {
        x: records[o + PlayerField.x]! / SUBTILES_PER_TILE,
        y: records[o + PlayerField.y]! / SUBTILES_PER_TILE,
        mining: records[o + PlayerField.mining] === 1,
        mineX: records[o + PlayerField.mineX]!,
        mineY: records[o + PlayerField.mineY]!,
        mineProgress: records[o + PlayerField.mineProgress]!,
      };
    },
    inventory: () => inventory().map((s) => ({ ...s })),
    craftQueue: () => {
      const snapshot = client.latestSnapshot;
      return snapshot ? decodeCraftQueue(snapshot.craftQueue) : { progress: 0, entries: [] };
    },
    tileToScreen: (x, y) => view.camera.worldToScreen((x + 0.5) * TILE_PX, (y + 0.5) * TILE_PX),
    renderedTile: (x, y) => view.terrain.tileAt(x, y),
    tileAtScreen: (sx, sy) => view.camera.tileAt(sx, sy),
    terrainStats: () => view.terrain.stats(),
    terrainReady: () => {
      // The worker must have caught up with the camera, and everything it sent must be baked.
      const expected = chunkWindow(view.camera.visibleTiles());
      const actual = view.terrain.chunkWindow;
      return (
        actual !== null &&
        (Object.keys(expected) as (keyof ChunkRect)[]).every((k) => expected[k] === actual[k]) &&
        view.terrain.isComplete()
      );
    },
    generatedTile: (x, y) => {
      world ??= new World(seed);
      return {
        terrain: world.tileAt(x, y),
        resource: world.resourceAt(x, y),
        amount: world.amountAt(x, y),
        tree: world.treeAt(x, y) ? 1 : 0,
      };
    },
    entities: () =>
      view.entityIndex.entities.map((e) => ({
        id: e.id,
        name: e.proto?.name ?? `entity#${String(e.type)}`,
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
        dir: e.dir,
        status: e.status,
        recipe: e.recipe,
      })),
    belts: () =>
      view.belts.data.map((b) => ({
        x: b.x,
        y: b.y,
        dir: b.dir,
        shape: b.shape,
        items: b.items.map(({ lane, offset, item }) => ({ lane, offset, item })),
      })),
    inserters: () => view.inserters.data.map((i) => ({ ...i })),
    dropOnBelt: (x, y, item, count = 1) => {
      const entity = view.entityIndex.at(x, y);
      if (entity?.type !== EntityTypeId.TransportBelt) return false;
      client.sendCommands([
        { type: 'Insert', playerId: LOCAL_PLAYER_ID, entity: entity.id, item, count },
      ]);
      return true;
    },
    power: () => structuredClone(view.power.data),
    generators: () => view.generators.engines,
    powerFocus: () => {
      const f = view.power.focus;
      return (
        f && { kind: f.kind, name: f.proto.name, x: f.x, y: f.y, connects: f.connects.slice() }
      );
    },
    ghost: () => {
      const g = build.ghost;
      if (!g) return null;
      const tiles = ghostInserterTiles(g);
      const drillDrop = ghostDrillDropTile(g);
      return {
        name: g.proto.name,
        x: g.x,
        y: g.y,
        dir: g.dir,
        valid: g.valid,
        ...tiles,
        ...(drillDrop ? { drop: drillDrop } : {}),
      };
    },
    selectedSlot: () => build.selected,
    openEntity: () => entityPanel.entity,
    openPowerPanel: () => powerPanel.pole,
    powerIcons: () => view.entities.powerIcons,
    assemblers: () => view.assemblers.machines.map((m) => ({ ...m })),
    sprites: () => ({
      models: view.spriteModels(),
      ...view.entities.sprites.stats,
      ghost: view.ghost.spriteShown,
    }),
  };
}
