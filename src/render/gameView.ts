/**
 * The game view: owns the camera, its input, and the world layers, and keeps
 * the worker's viewport in sync with what the camera shows.
 *
 * By default the camera follows the local player. Panning by hand frees it;
 * `follow()` (the `F` key) locks it onto the player again.
 *
 * The renderer never changes simulation state; it only reads snapshots.
 */

import { Container, type Application } from 'pixi.js';
import { SUBTILES_PER_TILE } from '../sim/fixed';
import { LOCAL_PLAYER_ID, type SnapshotMessage, type Viewport } from '../worker/protocol';
import { Camera, TILE_PX, type Point } from './camera';
import { CameraInput } from './cameraInput';
import { PlayerLayer } from './playerLayer';
import { PlayerTrack } from './playerTrack';
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
  readonly players = new PlayerLayer();
  /** Interpolated player positions from the snapshots. */
  readonly track = new PlayerTrack();
  readonly input: CameraInput;
  /** Whether the camera stays centered on the local player. */
  following = true;
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
    this.world.addChild(this.terrain.container, this.players.container);
    app.stage.addChild(this.world);
    this.input = new CameraInput(this.camera, app.canvas);
    this.input.onPan = () => {
      this.following = false;
    };
    this.camera.resize(app.screen.width, app.screen.height);
  }

  /** Feeds a snapshot from the worker into the layers. */
  applySnapshot(snapshot: SnapshotMessage): void {
    this.terrain.applySnapshot(snapshot.chunkWindow, snapshot.chunks);
    this.track.push(new Int32Array(snapshot.players), snapshot.ticksRun, performance.now());
  }

  /** Locks the camera onto the local player again. */
  follow(): void {
    this.following = true;
  }

  /** Where the local player is drawn now, in world pixels, or `null` before the first snapshot. */
  localPlayerPosition(nowMs: number = performance.now()): Point | null {
    const p = this.track.sample(LOCAL_PLAYER_ID, nowMs);
    return p && { x: (p.x * TILE_PX) / SUBTILES_PER_TILE, y: (p.y * TILE_PX) / SUBTILES_PER_TILE };
  }

  /** Advances input and layers by one rendered frame of `dtMs` milliseconds. */
  frame(dtMs: number): void {
    this.camera.resize(this.app.screen.width, this.app.screen.height);
    this.input.zoomAroundCenter = this.following;
    this.input.update(dtMs);
    const now = performance.now();
    if (this.following) {
      const p = this.localPlayerPosition(now);
      if (p) {
        this.camera.set(p.x, p.y);
      }
    }
    this.applyCamera();
    this.terrain.update();
    this.players.draw(this.track, now);
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
