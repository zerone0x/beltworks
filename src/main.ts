import { Application } from 'pixi.js';
import { AudioEngine } from './audio/engine';
import { GameAudio, createAudioContext } from './audio/gameAudio';
import { followVolumeSettings } from './audio/volume';
import { isPolePrototypeOf } from './sim/power/geometry';
import type { CommandInput } from './sim/commands';
import { PLAYER_INVENTORY_SLOTS } from './sim/inventory';
import {
  decodeCraftQueue,
  decodeEntityDetail,
  decodeInventory,
  decodeNetworkDetail,
  decodeResearch,
  NO_RESEARCH,
  PLAYER_STRIDE,
  PlayerField,
  type ResearchData,
  type SlotData,
} from './sim/snapshot';
import { BuildInput } from './render/buildInput';
import { TILE_PX } from './render/camera';
import { GameView } from './render/gameView';
import { PlayerInput } from './render/playerInput';
import { SPRITE_ATLASES, loadSpriteAtlases } from './render/sprites';
import { loadTerrainArt, type TerrainArt } from './render/terrainArt';
import { loadItemIcons } from './render/itemIcons';
import { CraftQueueStrip, CraftingPanel } from './ui/crafting';
import { CursorStack } from './ui/cursorStack';
import { DebugOverlay } from './ui/debugOverlay';
import { EntityPanel, hasEntityGui } from './ui/entityPanel';
import { GameMenu } from './ui/gameMenu';
import { HelpPanel } from './ui/help';
import {
  HOTBAR_SLOTS,
  Hotbar,
  InventoryPanel,
  barWidth,
  pinItem,
  pinNames,
  pinsFromNames,
  type Transfer,
} from './ui/inventory';
import { Minimap, minimapState } from './ui/minimap';
import { PowerHistory } from './ui/powerHistory';
import { PowerPanel } from './ui/powerPanel';
import { SaveController, chooseStart, type StartChoice } from './ui/saves';
import { SettingsStore, type Settings } from './ui/settings';
import { SettingsPanel } from './ui/settingsPanel';
import { TechTreePanel } from './ui/techTree';
import { UiScale } from './ui/uiScale';
import { SaveStore } from './save/store';
import { SimClient } from './worker/client';
import { LOCAL_PLAYER_ID } from './worker/protocol';

const BACKGROUND = 0x111418;
/** Fixed world seed until there is a new-game screen. */
const WORLD_SEED = 1;

async function main(): Promise<void> {
  const root = document.getElementById('app') ?? document.body;

  // Dev and test builds only: the test hook (installed below), its `?kit=` starting kit and
  // `?research=` researched technologies.
  const testHook =
    import.meta.env.DEV || import.meta.env.MODE === 'test' ? await import('./testHook') : null;
  // A save to continue (the start screen, or the menu's Load before it reloaded the page), or a new game;
  // a `?scene=` render scene (render profile) is always a fresh game: no start screen, no autosaves.
  const renderScene = testHook?.renderSceneFromUrl(window.location.search);
  const store = await SaveStore.open();
  const start: StartChoice = renderScene ? {} : await chooseStart(store);
  const client = new SimClient(
    WORLD_SEED,
    testHook?.startingKitFromUrl(window.location.search),
    testHook?.researchedFromUrl(window.location.search),
    start.save,
    renderScene,
  );
  const overlay = new DebugOverlay(document.body);
  /** The local player's inventory as of the latest snapshot. */
  let inventory: SlotData[] = [];
  /** The local player's force's research as of the latest snapshot. */
  let research: ResearchData = NO_RESEARCH;
  // Settings (keys, graphics, UI scale, volumes), per browser (D50).
  const settings = new SettingsStore();
  const uiScale = new UiScale();
  /**
   * Item ids pinned to the hotbar slots, 0 where a slot shows the inventory
   * slot of its index (D51): UI state, stored next to each save.
   */
  let pins: number[] = pinsFromNames(start.slot?.hotbar);
  /** The inventory slot under the pointer in the inventory window, or `null`. */
  let hoveredSlot: number | null = null;
  // The cursor (what the build input holds) exists once the canvas does.
  let build: BuildInput | null = null;
  const send = (commands: CommandInput[]): void => {
    client.sendCommands(commands);
  };
  /** Whether the cursor holds any units. */
  const cursorLive = (): boolean => (build?.handCount() ?? 0) > 0;
  /** The item the cursor holds, or 0. */
  const cursorItem = (): number =>
    build && cursorLive() ? (inventory[build.selected!]?.item ?? 0) : 0;
  const setPins = (next: number[]): void => {
    pins = next;
    hotbar.update(inventory, pins);
    build?.refresh();
  };
  /**
   * A click on inventory slot `slot` moving `transfer`, in the inventory
   * window or (while holding a stack) an entity window's copy (D52): with
   * nothing held, a click picks up the stack (a right click half of it, a
   * ctrl or middle click one); holding one, a click on its own slot puts it
   * back, on another slot puts it there (a ctrl or middle click one unit),
   * and a right click puts it away.
   */
  const clickInventorySlot = (slot: number, transfer: Transfer): void => {
    if (!build) return;
    const stack = inventory[slot];
    const full = stack !== undefined && stack.count > 0;
    if (transfer === 'half') {
      if (build.selection !== null) build.select(null);
      else if (full) build.pickUp(slot, Math.ceil(stack.count / 2));
      return;
    }
    if (!cursorLive()) {
      if (full) build.pickUp(slot, transfer === 'one' ? 1 : null);
      return;
    }
    const from = build.selected!;
    if (from === slot) {
      if (transfer === 'all') build.select(null);
      return;
    }
    const count = transfer === 'one' ? 1 : build.handCount();
    send([{ type: 'MoveStack', playerId: LOCAL_PLAYER_ID, from, to: slot, count }]);
    if (transfer === 'all') build.select(null);
  };
  // Hotbar clicks select like the number keys; holding a stack picked up
  // past the hotbar with the inventory open, a click pins its item there.
  const hotbar = new Hotbar(document.body, {
    onClick: (slot, transfer) => {
      if (!build) return;
      if (transfer === 'one') {
        // Middle click (or ctrl-click): unpin.
        if (pins[slot] !== 0) setPins(pinItem(pins, slot, 0));
        return;
      }
      if (transfer === 'half') {
        build.select(null);
        return;
      }
      const held = build.selection;
      if (held?.kind === 'slot' && inventoryPanel.isOpen && cursorLive()) {
        setPins(pinItem(pins, slot, cursorItem()));
        build.selectHotbar(slot);
      } else if (held?.kind === 'hotbar' && held.index === slot) {
        build.select(null);
      } else {
        build.selectHotbar(slot);
      }
    },
    onDrop: (source, from, slot) => {
      // A drag from the inventory pins the dragged item.
      const item = source === inventoryPanel.grid ? (inventory[from]?.item ?? 0) : 0;
      if (item !== 0) setPins(pinItem(pins, slot, item));
    },
  });
  // Clicks in the inventory window pick up and drop the cursor stack; in an
  // entity window (which has its own copy of the inventory) they move stacks
  // in and out of the entity instead (D11), unless the cursor holds a stack.
  const inventoryPanel = new InventoryPanel(document.body, PLAYER_INVENTORY_SLOTS, {
    onClick: clickInventorySlot,
    onDrop: (source, from, to) => {
      const count = inventory[from]?.count ?? 0;
      if (source === inventoryPanel.grid && count > 0) {
        send([{ type: 'MoveStack', playerId: LOCAL_PLAYER_ID, from, to, count }]);
      }
    },
    onHover: (slot) => {
      hoveredSlot = slot;
    },
  });
  const entityPanel = new EntityPanel(document.body, PLAYER_INVENTORY_SLOTS, {
    insert: (entity, item, count) => {
      client.sendCommands([{ type: 'Insert', playerId: LOCAL_PLAYER_ID, entity, item, count }]);
    },
    take: (entity, slot, count) => {
      client.sendCommands([{ type: 'Take', playerId: LOCAL_PLAYER_ID, entity, slot, count }]);
    },
    inspect: (entity) => {
      client.inspect(entity);
    },
    setRecipe: (entity, recipe) => {
      client.sendCommands([{ type: 'SetRecipe', playerId: LOCAL_PLAYER_ID, entity, recipe }]);
    },
    dropCursorInto: (entity) => {
      const item = cursorItem();
      if (!build || item === 0) return false;
      send([{ type: 'Insert', playerId: LOCAL_PLAYER_ID, entity, item, count: build.handCount() }]);
      build.select(null);
      return true;
    },
    dropCursorOnSlot: (slot, transfer) => {
      if (!cursorLive()) return false;
      clickInventorySlot(slot, transfer);
      return true;
    },
  });
  const crafting = {
    playerId: LOCAL_PLAYER_ID,
    send: (commands: CommandInput[]) => {
      client.sendCommands(commands);
    },
  };
  const craftingPanel = new CraftingPanel(crafting);
  inventoryPanel.addSection(craftingPanel.element);
  const craftQueue = new CraftQueueStrip(document.body, crafting);
  const powerHistory = new PowerHistory();
  const powerPanel = new PowerPanel(document.body, powerHistory, (pole) => {
    client.inspect(pole);
  });
  const techTree = new TechTreePanel(document.body, crafting);
  const help = new HelpPanel(document.body);
  const cursorStack = new CursorStack(document.body);
  let menu: GameMenu | null = null;
  const saves = new SaveController(
    store,
    client,
    (message) => {
      menu?.notify(message);
      if (menu?.isOpen) menu.setStatus(message);
    },
    () => pinNames(pins),
  );
  const settingsPanel = new SettingsPanel(settings);
  menu = new GameMenu(
    document.body,
    {
      save: (name) => saves.save(name),
      list: () => saves.list(),
      load: (slot) => {
        saves.load(slot);
      },
      export: (slot) => saves.export(slot),
      delete: (slot) => saves.delete(slot),
      import: (file) => saves.import(file),
      newGame: () => {
        saves.newGame();
      },
      otherWindowOpen: () =>
        entityPanel.isOpen ||
        inventoryPanel.isOpen ||
        powerPanel.isOpen ||
        techTree.isOpen ||
        help.isOpen,
    },
    settingsPanel,
  );
  // Single-player: the game pauses behind the menu (the simulation just runs no ticks).
  menu.onToggle = (open) => {
    client.setPaused(open);
  };
  // The UI scale setting scales each part of the interface around where it is anchored.
  const hotbarWidth = barWidth(HOTBAR_SLOTS);
  uiScale.register(hotbar.element, '50% 100%');
  // The crafting queue sits on the hotbar: it scales around the hotbar's bottom center.
  uiScale.register(
    craftQueue.element,
    `${String(Math.round(hotbarWidth / 2))}px calc(100% + ${String(barWidth(1) + 6)}px)`,
  );
  uiScale.register(inventoryPanel.element, '0 0');
  uiScale.register(entityPanel.element, '100% 0');
  uiScale.register(powerPanel.element, '100% 0');
  uiScale.register(techTree.element, '50% 50%');
  uiScale.register(techTree.status, '50% 0');
  uiScale.register(help.hint, '0 100%');
  // The help panel sits above the hint: it scales around the hint's corner.
  uiScale.register(help.element, '0 calc(100% + 52px)');
  uiScale.register(menu.button, '100% 0');
  uiScale.register(menu.panel, '50% 50%');
  uiScale.register(settingsPanel.element, '50% 50%');
  client.onLoaded = (msg) => {
    if (msg.error !== null) {
      menu?.notify(`Couldn't load the save: ${msg.error} A new game was started instead.`, 10_000);
    } else if (start.slot) {
      menu?.notify(`Loaded “${start.slot.name}”.`);
    }
  };
  if (!renderScene) saves.startAutosave();
  client.onStats = (stats) => {
    overlay.update(stats);
  };

  const app = new Application();
  await app.init({
    background: BACKGROUND,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  root.appendChild(app.canvas);

  const view = new GameView(app, (viewport) => {
    client.setViewport(viewport);
  });
  const minimap = new Minimap(document.body, view.mapStore, (tile) => {
    view.following = false;
    view.camera.set(tile.x * TILE_PX, tile.y * TILE_PX);
  });
  uiScale.register(minimap.element, '100% 100%');
  const sprites = `${import.meta.env.BASE_URL}sprites/`;
  // Test builds draw the flat placeholder terrain unless a spec asks for the
  // rendered one (`?art=1`), which is slow to bake in CI's software renderer;
  // otherwise the terrain setting decides (and decides alone once changed).
  let terrainOverride = testHook?.renderedTerrainFromUrl(
    window.location.search,
    import.meta.env.MODE,
  );
  const terrainTexels = testHook?.terrainTexelsFromUrl(window.location.search);
  let terrainArt: Promise<TerrainArt | null> | null = null;
  let terrainRequest = 0;
  /** Draws the terrain the way the settings (or the URL) ask, loading its art the first time. */
  function applyTerrain(): Promise<void> {
    const graphics = settings.value.graphics;
    const rendered = terrainOverride ?? graphics.terrain === 'rendered';
    const request = ++terrainRequest;
    if (rendered) {
      terrainArt ??= loadTerrainArt(`${sprites}terrain.json`).catch((err: unknown) => {
        console.warn('terrain art: keeping the flat terrain:', err);
        return null;
      });
    }
    return (rendered ? terrainArt! : Promise.resolve(null)).then((art) => {
      if (request === terrainRequest) {
        view.setTerrainArt(art, terrainTexels, graphics.terrainDetail === 'low');
      }
    });
  }
  /** Applies the settings (all of them at startup, with `previous` null). */
  function applySettings(next: Settings, previous: Settings | null): void {
    uiScale.set(next.uiScale);
    minimap.uiScale = next.uiScale;
    view.animate = next.graphics.animation;
    view.setShadows(next.graphics.shadows);
    help.refresh();
    const g = next.graphics;
    const p = previous?.graphics;
    if (p && g.terrain !== p.terrain) terrainOverride = undefined;
    if (p && (g.terrain !== p.terrain || g.terrainDetail !== p.terrainDetail)) {
      void applyTerrain();
    }
  }
  applySettings(settings.value, null);
  settings.subscribe(applySettings);
  // Pre-rendered sprites (docs/ART.md); placeholders until (or unless) they load.
  // The game runs with its placeholders until (or unless) each part loads.
  void Promise.allSettled([
    loadSpriteAtlases(SPRITE_ATLASES.map((name) => `${sprites}${name}.json`)).then((atlas) => {
      view.setSprites(atlas);
    }),
    loadItemIcons(`${sprites}icons.json`),
    applyTerrain(),
  ]).then(() => {
    view.artSettled = true;
  });
  // Sound (D55): silent until the first user gesture, muted while the tab is hidden.
  // Test builds stay silent unless a spec asks for sound (`?audio=1`).
  const withAudio = testHook?.audioFromUrl(window.location.search, import.meta.env.MODE) ?? true;
  const engine = new AudioEngine({ createContext: withAudio ? createAudioContext : () => null });
  const audio = new GameAudio(engine, {
    listener: () => ({
      x: view.camera.x / TILE_PX,
      y: view.camera.y / TILE_PX,
      zoom: view.camera.zoom,
    }),
    entities: () => view.entityIndex.entities,
    inserters: () => view.inserters.data,
    networks: () => view.power.data.networks,
    player: () => {
      const r = view.track.latest;
      const o = LOCAL_PLAYER_ID * PLAYER_STRIDE;
      if (r.length < o + PLAYER_STRIDE) return null;
      return {
        mining: r[o + PlayerField.mining] === 1,
        mineX: r[o + PlayerField.mineX]!,
        mineY: r[o + PlayerField.mineY]!,
        mineProgress: r[o + PlayerField.mineProgress]!,
      };
    },
  });
  followVolumeSettings(engine, settings);
  const input = new PlayerInput({
    element: app.canvas,
    playerId: LOCAL_PLAYER_ID,
    send: (commands) => {
      client.sendCommands(commands);
    },
    pointer: () => view.input.pointer,
    tileAt: (sx, sy) => view.camera.tileAt(sx, sy),
    isMineable: (x, y) => {
      const tile = view.terrain.tileAt(x, y);
      return tile !== null && (tile.resource !== 0 || tile.tree !== 0);
    },
    entityAt: (x, y) => view.entityIndex.at(x, y)?.id ?? 0,
    onToggleInventory: () => {
      // Like Escape, E first closes an open entity window (which shows the
      // inventory already) rather than opening a second inventory next to it.
      if (entityPanel.isOpen) {
        entityPanel.close();
        return;
      }
      inventoryPanel.toggle();
      const queue = client.latestSnapshot && decodeCraftQueue(client.latestSnapshot.craftQueue);
      craftingPanel.update(inventory, queue?.entries.length ?? 0, research);
    },
    onFollow: () => {
      view.follow();
    },
  });

  const buildInput = new BuildInput({
    element: app.canvas,
    playerId: LOCAL_PLAYER_ID,
    send: (commands) => {
      client.sendCommands(commands);
    },
    pointer: () => view.input.pointer,
    screenToWorld: (sx, sy) => view.camera.screenToWorld(sx, sy),
    tileAt: (sx, sy) => view.camera.tileAt(sx, sy),
    inventory: () => inventory,
    entityAt: (x, y) => view.entityIndex.at(x, y),
    canPlace: (proto, x, y, dir) => view.canPlace(proto, x, y, dir),
    hotbarPin: (index) => pins[index] ?? 0,
    onSelect: (slot, hotbarSlot) => {
      hotbar.select(hotbarSlot);
      inventoryPanel.select(slot);
      entityPanel.selectInventorySlot(slot);
    },
    onAssignHotbar: (index) => {
      // Alt and a hotbar key: pin the held item, else the one under the
      // mouse in the inventory window.
      const hovered = inventoryPanel.isOpen && hoveredSlot !== null ? inventory[hoveredSlot] : null;
      const item = cursorItem() || (hovered && hovered.count > 0 ? hovered.item : 0);
      if (item !== 0) setPins(pinItem(pins, index, item));
    },
    onOpenEntity: (entity) => {
      // Both windows use the worker's one `inspect` slot: close the other one first.
      if (isPolePrototypeOf(entity.proto)) {
        entityPanel.close();
        powerPanel.open(entity.id);
        return;
      }
      if (!hasEntityGui(entity.type)) return;
      powerPanel.close();
      // The entity window shows the inventory too; one is enough.
      inventoryPanel.close();
      entityPanel.open(entity.id, entity.type);
    },
  });
  build = buildInput;
  // Every snapshot must reach the view, in order, or its chunk cache drifts from
  // what the worker thinks was sent. Snapshots before this point carry no
  // chunks: the worker only sends them once it has a viewport, and the first
  // one goes out on the first frame below.
  client.onSnapshot = (snapshot) => {
    view.applySnapshot(snapshot);
    inventory = decodeInventory(snapshot.inventory);
    research = decodeResearch(snapshot.research);
    techTree.update(research);
    hotbar.update(inventory, pins);
    inventoryPanel.update(inventory);
    const detail = snapshot.entityDetail ? decodeEntityDetail(snapshot.entityDetail) : null;
    entityPanel.update(snapshot.inspected, detail, inventory);
    const network = snapshot.networkDetail ? decodeNetworkDetail(snapshot.networkDetail) : null;
    const figures = view.power.data.networks.filter((n) => n.id !== network?.network);
    powerHistory.record(
      snapshot.tick,
      network ? [...figures, { id: network.network, ...network }] : figures,
    );
    powerPanel.update(snapshot.inspected, network);
    const queue = decodeCraftQueue(snapshot.craftQueue);
    craftQueue.update(queue);
    if (inventoryPanel.isOpen) {
      craftingPanel.update(inventory, queue.entries.length, research);
    }
    audio.onSnapshot(snapshot, queue, research);
  };
  app.ticker.add((ticker) => {
    view.frame(ticker.deltaMS);
    if (minimap.isOpen) minimap.update(minimapState(view.camera, view.localPlayerPosition()));
    input.update();
    buildInput.update();
    view.drawGhost(buildInput.ghost);
    // The held stack shows at the cursor in windows with slots (the ghost shows it over the game).
    const windowOpen = inventoryPanel.isOpen || entityPanel.isOpen;
    cursorStack.show(cursorItem(), windowOpen ? buildInput.handCount() : 0);
    overlay.updateTile(view.hoveredTile());
    audio.frame();
  });

  if (testHook) {
    testHook.installTestHook({
      client,
      view,
      build: buildInput,
      entityPanel,
      powerPanel,
      techTree,
      minimap,
      saves,
      audio: engine,
      seed: WORLD_SEED,
      inventory: () => inventory,
      research: () => research,
      ticker: app.ticker,
      screen: () => ({
        width: app.screen.width,
        height: app.screen.height,
        resolution: app.renderer.resolution,
      }),
      hotbarPins: () => pins,
    });
  }
}

main().catch((err: unknown) => {
  console.error('Failed to start Beltworks', err);
});
