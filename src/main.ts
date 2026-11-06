import { Application, Text } from 'pixi.js';

const BACKGROUND = 0x111418;

async function main(): Promise<void> {
  const app = new Application();
  await app.init({
    background: BACKGROUND,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  (document.getElementById('app') ?? document.body).appendChild(app.canvas);

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
  center();
  app.renderer.on('resize', center);
}

main().catch((err: unknown) => {
  console.error('Failed to start Beltworks', err);
});
