import { Application, Text } from 'pixi.js';
import { DebugOverlay } from './ui/debugOverlay';
import { SimClient } from './worker/client';

const BACKGROUND = 0x111418;
/** Fixed world seed until there is a new-game screen. */
const WORLD_SEED = 1;
const TILE_PX = 32;

async function main(): Promise<void> {
  const root = document.getElementById('app') ?? document.body;

  const client = new SimClient(WORLD_SEED);
  const overlay = new DebugOverlay(document.body);
  client.onStats = (stats) => {
    overlay.update(stats);
  };
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    const { installTestHook } = await import('./testHook');
    installTestHook(client);
  }

  const app = new Application();
  await app.init({
    background: BACKGROUND,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  root.appendChild(app.canvas);

  const title = new Text({
    text: 'Beltworks',
    style: {
      fill: 0xe8e2d0,
      fontFamily: 'system-ui, sans-serif',
      fontSize: 64,
      fontWeight: '700',
      letterSpacing: 2,
    },
  });
  title.anchor.set(0.5);
  app.stage.addChild(title);

  const center = (): void => {
    title.position.set(app.screen.width / 2, app.screen.height / 2);
  };
  // Until the camera exists, the viewport is the screen at 32 px per tile, centered on (0, 0).
  const sendViewport = (): void => {
    const w = Math.ceil(app.screen.width / TILE_PX);
    const h = Math.ceil(app.screen.height / TILE_PX);
    client.setViewport({ x: -Math.floor(w / 2), y: -Math.floor(h / 2), w, h });
  };
  const onResize = (): void => {
    center();
    sendViewport();
  };
  onResize();
  app.renderer.on('resize', onResize);
}

main().catch((err: unknown) => {
  console.error('Failed to start Beltworks', err);
});
