import { Application } from 'pixi.js';
import type { CommandInput } from './sim/commands';
import { PLAYER_INVENTORY_SLOTS } from './sim/inventory';
import {
  decodeCraftQueue,
  decodeEntityDetail,
  decodeInventory,
  type SlotData,
} from './sim/snapshot';
import { BuildInput } from './render/buildInput';
import { GameView } from './render/gameView';
import { PlayerInput } from './render/playerInput';
import { CraftQueueStrip, CraftingPanel } from './ui/crafting';
import { DebugOverlay } from './ui/debugOverlay';
import { EntityPanel, hasEntityGui } from './ui/entityPanel';
import { HelpPanel } from './ui/help';
import { Hotbar, InventoryPanel } from './ui/inventory';
import { SimClient } from './worker/client';
import { LOCAL_PLAYER_ID } from './worker/protocol';

const BACKGROUND = 0x111418;
/** Fixed world seed until there is a new-game screen. */
const WORLD_SEED = 1;

async function main(): Promise<void> {
  const root = document.getElementById('app') ?? document.body;

  const client = new SimClient(WORLD_SEED);
  const overlay = new DebugOverlay(document.body);
  // Hotbar clicks select like the number keys (the build input exists once the canvas does).
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
  const inventoryPanel = new InventoryPanel(document.body, PLAYER_INVENTORY_SLOTS);
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
      craftingPanel.update(inventory, queue?.entries.length ?? 0);
    },
    onFollow: () => {
      view.follow();
    },
  });

  let inventory: SlotData[] = [];
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
    },
    onOpenEntity: (entity) => {
      if (!hasEntityGui(entity.type)) return;
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
    hotbar.update(inventory);
    inventoryPanel.update(inventory);
    const detail = snapshot.entityDetail ? decodeEntityDetail(snapshot.entityDetail) : null;
    entityPanel.update(snapshot.inspected, detail, inventory);
    const queue = decodeCraftQueue(snapshot.craftQueue);
    craftQueue.update(queue);
    if (inventoryPanel.isOpen) {
      craftingPanel.update(inventory, queue.entries.length);
    }
  };
  app.ticker.add((ticker) => {
    view.frame(ticker.deltaMS);
    input.update();
    build.update();
    view.drawGhost(build.ghost);
    overlay.updateTile(view.hoveredTile());
  });

  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    const { installTestHook } = await import('./testHook');
    installTestHook({
      client,
      view,
      build,
      entityPanel,
      seed: WORLD_SEED,
      inventory: () => inventory,
    });
  }
}

main().catch((err: unknown) => {
  console.error('Failed to start Beltworks', err);
});
