import { Application } from 'pixi.js';
import { PLAYER_INVENTORY_SLOTS } from './sim/inventory';
import { decodeEntityDetail, decodeInventory, type SlotData } from './sim/snapshot';
import { BuildInput } from './render/buildInput';
import { GameView } from './render/gameView';
import { PlayerInput } from './render/playerInput';
import { DebugOverlay } from './ui/debugOverlay';
import { EntityPanel, hasEntityGui } from './ui/entityPanel';
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
  const hotbar = new Hotbar(document.body);
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
    isMineable: (x, y) => (view.terrain.tileAt(x, y)?.resource ?? 0) !== 0,
    entityAt: (x, y) => view.entityIndex.at(x, y)?.id ?? 0,
    onToggleInventory: () => {
      inventoryPanel.toggle();
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
      if (hasEntityGui(entity.type)) entityPanel.open(entity.id, entity.type);
    },
  });
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
