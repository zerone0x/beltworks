import { Application } from 'pixi.js';
import { GameView } from './render/gameView';
import { DebugOverlay } from './ui/debugOverlay';
import { SimClient } from './worker/client';

const BACKGROUND = 0x111418;
/** Fixed world seed until there is a new-game screen. */
const WORLD_SEED = 1;

async function main(): Promise<void> {
  const root = document.getElementById('app') ?? document.body;

  const client = new SimClient(WORLD_SEED);
  const overlay = new DebugOverlay(document.body);
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
  // Every snapshot must reach the view, in order, or its chunk cache drifts from
  // what the worker thinks was sent. Snapshots before this point carry no
  // chunks: the worker only sends them once it has a viewport, and the first
  // one goes out on the first frame below.
  client.onSnapshot = (snapshot) => {
    view.applySnapshot(snapshot);
  };
  app.ticker.add((ticker) => {
    view.frame(ticker.deltaMS);
    overlay.updateTile(view.hoveredTile());
  });

  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    const { installTestHook } = await import('./testHook');
    installTestHook(client, view, WORLD_SEED);
  }
}

main().catch((err: unknown) => {
  console.error('Failed to start Beltworks', err);
});
