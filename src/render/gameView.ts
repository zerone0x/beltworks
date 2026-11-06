/**
 * The game view: owns the camera, its input, and the world layers, and keeps
 * the worker's viewport in sync with what the camera shows.
 *
 * The renderer never changes simulation state; it only reads snapshots.
 */

import { Container, type Application } from 'pixi.js';
import type { SnapshotMessage, Viewport } from '../worker/protocol';
import { Camera, type Point } from './camera';
import { CameraInput } from './cameraInput';
import { TerrainLayer, type TileInfo } from './terrainLayer';

export interface HoveredTile extends Point {
  /** `null` while the chunk under the pointer hasn't arrived from the worker. */
  info: TileInfo | null;
}

const sameViewport = (a: Viewport | null, b: Viewport): boolean =>
  a !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export class GameView {
  readonly camera = new Camera();
  readonly terrain = new TerrainLayer();
  readonly input: CameraInput;
  /** Everything positioned in world pixels; transformed by the camera. */
  private readonly world = new Container({ label: 'world' });
  private sentViewport: Viewport | null = null;

  /**
   * @param onViewport Called with the tiles on screen whenever they change;
   *   forward it to the worker (`setViewport`).
   */
  constructor(
    private readonly app: Application,
    private readonly onViewport: (viewport: Viewport) => void,
  ) {
    this.world.addChild(this.terrain.container);
    app.stage.addChild(this.world);
    this.input = new CameraInput(this.camera, app.canvas);
    this.camera.resize(app.screen.width, app.screen.height);
  }

  /** Feeds a snapshot from the worker into the layers. */
  applySnapshot(snapshot: SnapshotMessage): void {
    this.terrain.applySnapshot(snapshot.chunkWindow, snapshot.chunks);
  }

  /** Advances input and layers by one rendered frame of `dtMs` milliseconds. */
  frame(dtMs: number): void {
    this.camera.resize(this.app.screen.width, this.app.screen.height);
    this.input.update(dtMs);
    this.applyCamera();
    this.terrain.update();
  }

  /** The tile under the pointer, or `null` when the pointer is not over the canvas. */
  hoveredTile(): HoveredTile | null {
    const p = this.input.pointer;
    if (!p) {
      return null;
    }
    const tile = this.camera.tileAt(p.x, p.y);
    return { ...tile, info: this.terrain.tileAt(tile.x, tile.y) };
  }

  private applyCamera(): void {
    const { camera, world } = this;
    // Snap the world origin to whole device pixels so chunk edges and texels
    // don't shimmer while panning.
    const res = this.app.renderer.resolution;
    const ox = Math.round((camera.width / 2 - camera.x * camera.zoom) * res) / res;
    const oy = Math.round((camera.height / 2 - camera.y * camera.zoom) * res) / res;
    world.position.set(ox, oy);
    world.scale.set(camera.zoom);

    const viewport = camera.visibleTiles();
    if (!sameViewport(this.sentViewport, viewport)) {
      this.sentViewport = viewport;
      this.onViewport(viewport);
    }
  }
}
