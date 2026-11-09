/**
 * Everything the game needs PixiJS for at startup: the renderer, the game
 * view and the art loaders. main.ts imports this module dynamically
 * (loadRenderer.ts), so PixiJS loads in its own chunks while the title
 * screen is up instead of before it (D64). Nothing the title screen uses may
 * import from here, or from any other module that imports `pixi.js`.
 */

export { Application } from 'pixi.js';
export { GameView } from './gameView';
export { SPRITE_ATLASES, loadSpriteAtlases } from './sprites';
export { loadTerrainArt } from './terrainArt';
