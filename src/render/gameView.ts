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
import type { EntityPrototype } from '../data/entities';
import { isBuildable } from '../data/tiles';
import type { Direction } from '../sim/entities/direction';
import { Placement, checkPlacement, type PlacementView } from '../sim/entities/placement';
import { SUBTILES_PER_TILE } from '../sim/fixed';
import { PLAYER_STRIDE, PlayerField } from '../sim/snapshot';
import { isTileInMap } from '../sim/world/world';
import { LOCAL_PLAYER_ID, type SnapshotMessage, type Viewport } from '../worker/protocol';
import { BeltLayer } from './beltLayer';
import { Camera, TILE_PX, type Point } from './camera';
import { CameraInput } from './cameraInput';
import { EntityIndex } from './entityIndex';
import { EntityLayer, GhostLayer, type Ghost } from './entityLayer';
import { InserterLayer } from './inserterLayer';
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
  /** Entities around the view, from the latest snapshot. */
  readonly entityIndex = new EntityIndex();
  readonly entities = new EntityLayer();
  /** Belts and the items on them, below the other entities. */
  readonly belts = new BeltLayer();
  /** Inserter arms and what they hold, above the buildings. */
  readonly inserters = new InserterLayer();
  readonly ghost = new GhostLayer();
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
    this.world.addChild(
      this.terrain.container,
      this.belts.container,
      this.belts.itemContainer,
      this.entities.container,
      this.inserters.container,
      this.players.container,
      this.ghost.container,
    );
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
    this.entityIndex.apply(snapshot.entities);
    this.belts.apply(snapshot.belts, snapshot.tick, performance.now());
    this.inserters.apply(snapshot.inserters, performance.now());
  }

  /**
   * Whether `proto` can be placed facing `dir` at `(x, y)` by the local
   * player, judged with the simulation's own rules (src/sim/entities/placement.ts)
   * on the latest snapshot. Tiles whose chunk hasn't arrived count as blocked.
   */
  canPlace(proto: EntityPrototype, x: number, y: number, dir: Direction): boolean {
    const records = this.track.latest;
    const o = LOCAL_PLAYER_ID * PLAYER_STRIDE;
    if (records.length < o + PLAYER_STRIDE) {
      return false;
    }
    const view: PlacementView = {
      inMap: isTileInMap,
      buildable: (tx, ty) => {
        const tile = this.terrain.tileAt(tx, ty);
        return tile !== null && isBuildable(tile.terrain);
      },
      tree: (tx, ty) => this.terrain.tileAt(tx, ty)?.tree === 1,
      occupant: (tx, ty) => this.entityIndex.at(tx, ty)?.id ?? 0,
      playerCount: this.track.count,
      playerX: (i) => records[i * PLAYER_STRIDE + PlayerField.x]!,
      playerY: (i) => records[i * PLAYER_STRIDE + PlayerField.y]!,
    };
    const px = records[o + PlayerField.x]!;
    const py = records[o + PlayerField.y]!;
    return checkPlacement(view, proto, x, y, dir, px, py) === Placement.Ok;
  }

  /** Shows the ghost preview, or hides it for `null`. */
  drawGhost(ghost: Ghost | null): void {
    this.ghost.draw(ghost);
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
    this.belts.draw(now);
    this.entities.draw(this.entityIndex);
    this.inserters.draw(now);
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
