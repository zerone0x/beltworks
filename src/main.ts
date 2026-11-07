import { Application } from 'pixi.js';
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
  type ResearchData,
  type SlotData,
} from './sim/snapshot';
import { BuildInput, isPlaceableSlot } from './render/buildInput';
import { GameView } from './render/gameView';
import { PlayerInput } from './render/playerInput';
import { loadSpriteAtlas } from './render/sprites';
import { CraftQueueStrip, CraftingPanel } from './ui/crafting';
import { DebugOverlay } from './ui/debugOverlay';
import { EntityPanel, hasEntityGui } from './ui/entityPanel';
import { HelpPanel } from './ui/help';
import { Hotbar, InventoryPanel } from './ui/inventory';
import { PowerHistory } from './ui/powerHistory';
import { PowerPanel } from './ui/powerPanel';
import { TechTreePanel } from './ui/techTree';
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
  const client = new SimClient(
    WORLD_SEED,
    testHook?.startingKitFromUrl(window.location.search),
    testHook?.researchedFromUrl(window.location.search),
  );
  const overlay = new DebugOverlay(document.body);
  /** The local player's inventory as of the latest snapshot. */
  let inventory: SlotData[] = [];
  /** The local player's force's research as of the latest snapshot. */
  let research: ResearchData = NO_RESEARCH;
  // Hotbar clicks select like the number keys, and inventory clicks select any
  // slot with a placeable item (the build input exists once the canvas does).
  let selectSlot: (slot: number | null) => void = () => undefined;
  let selectedSlot: () => number | null = () => null;
  const hotbar = new Hotbar(document.body, {
    onClick: (slot) => {
      selectSlot(slot === selectedSlot() ? null : slot);
    },
    onRightClick: () => {
      selectSlot(null);
    },
  });
  // Clicks in the inventory window select for building; in an entity window
  // (which has its own copy of the inventory) they move stacks instead (D11).
  const inventoryPanel = new InventoryPanel(document.body, PLAYER_INVENTORY_SLOTS, {
    onClick: (slot) => {
      if (slot === selectedSlot()) selectSlot(null);
      else if (isPlaceableSlot(inventory, slot)) selectSlot(slot);
    },
    onRightClick: () => {
      selectSlot(null);
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
  new HelpPanel(document.body);
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
  // Pre-rendered sprites (docs/ART.md); placeholders until (or unless) they load.
  void loadSpriteAtlas(`${import.meta.env.BASE_URL}sprites/entities.json`).then((atlas) => {
    view.setSprites(atlas);
  });
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

  const build = new BuildInput({
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
    onSelect: (slot) => {
      hotbar.select(slot);
      inventoryPanel.select(slot);
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
  selectSlot = (slot) => {
    build.select(slot);
  };
  selectedSlot = () => build.selected;
  // Every snapshot must reach the view, in order, or its chunk cache drifts from
  // what the worker thinks was sent. Snapshots before this point carry no
  // chunks: the worker only sends them once it has a viewport, and the first
  // one goes out on the first frame below.
  client.onSnapshot = (snapshot) => {
    view.applySnapshot(snapshot);
    inventory = decodeInventory(snapshot.inventory);
    research = decodeResearch(snapshot.research);
    techTree.update(research);
    hotbar.update(inventory);
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
  };
  app.ticker.add((ticker) => {
    view.frame(ticker.deltaMS);
    input.update();
    build.update();
    view.drawGhost(build.ghost);
    overlay.updateTile(view.hoveredTile());
  });

  if (testHook) {
    testHook.installTestHook({
      client,
      view,
      build,
      entityPanel,
      powerPanel,
      techTree,
      seed: WORLD_SEED,
      inventory: () => inventory,
      research: () => research,
    });
  }
}

main().catch((err: unknown) => {
  console.error('Failed to start Beltworks', err);
});
