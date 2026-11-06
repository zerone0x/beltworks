import { Application } from 'pixi.js';
import { PLAYER_INVENTORY_SLOTS } from './sim/inventory';
import { decodeInventory, type SlotData } from './sim/snapshot';
import { GameView } from './render/gameView';
import { PlayerInput } from './render/playerInput';
import { DebugOverlay } from './ui/debugOverlay';
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
    onToggleInventory: () => {
      inventoryPanel.toggle();
    },
    onFollow: () => {
      view.follow();
    },
  });

  let inventory: SlotData[] = [];
  // Every snapshot must reach the view, in order, or its chunk cache drifts from
  // what the worker thinks was sent. Snapshots before this point carry no
  // chunks: the worker only sends them once it has a viewport, and the first
  // one goes out on the first frame below.
  client.onSnapshot = (snapshot) => {
    view.applySnapshot(snapshot);
    inventory = decodeInventory(snapshot.inventory);
    hotbar.update(inventory);
    inventoryPanel.update(inventory);
  };
  app.ticker.add((ticker) => {
    view.frame(ticker.deltaMS);
    input.update();
    overlay.updateTile(view.hoveredTile());
  });

  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    const { installTestHook } = await import('./testHook');
    installTestHook({ client, view, seed: WORLD_SEED, inventory: () => inventory });
  }
}

main().catch((err: unknown) => {
  console.error('Failed to start Beltworks', err);
});
