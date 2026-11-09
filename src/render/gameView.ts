/**
 * The game view: owns the camera, its input, and the world layers, and keeps
 * the worker's viewport in sync with what the camera shows.
 *
 * By default the camera follows the local player. Panning by hand frees it;
 * `follow()` (the `F` key) locks it onto the player again.
 *
 * Zoomed out past `MAP_ZOOM` the view fades into map mode (mapLayer.ts):
 * flat colours per tile from the map store, which the minimap shares, and
 * once the fade is done the terrain and entity layers are hidden and not
 * drawn at all.
 *
 * The renderer never changes simulation state; it only reads snapshots.
 */

import { Container, type Application } from 'pixi.js';
import { EntityTypeId, type EntityPrototype } from '../data/entities';
import { isBuildable } from '../data/tiles';
import type { Direction } from '../sim/entities/direction';
import { Placement, checkPlacement, type PlacementView } from '../sim/entities/placement';
import { SUBTILES_PER_TILE } from '../sim/fixed';
import { PLAYER_STRIDE, PlayerField } from '../sim/snapshot';
import { isTileInMap } from '../sim/world/world';
import { LOCAL_PLAYER_ID, type SnapshotMessage, type Viewport } from '../worker/protocol';
import { AssemblerLayer } from './assemblerLayer';
import { BeltLayer } from './beltLayer';
import { Camera, TILE_PX, type Point } from './camera';
import { CameraInput } from './cameraInput';
import { cullRect } from './cull';
import { EntityIndex } from './entityIndex';
import { EntityLayer, GhostLayer, type Ghost, type TileBoxLike } from './entityLayer';
import { GeneratorLayer } from './generatorLayer';
import { InserterLayer } from './inserterLayer';
import { MapLayer, stepMapBlend, wantsMapMode } from './mapLayer';
import { MapStore } from './mapStore';
import { PlayerLayer } from './playerLayer';
import { PlayerTrack } from './playerTrack';
import { PowerLayer, powerFocus } from './powerLayer';
import type { SpriteAtlas } from './sprites';
import type { TerrainArt } from './terrainArt';
import { TerrainLayer, type TileInfo } from './terrainLayer';
import { GPU_MAX_TEXELS, SOFTWARE_MAX_TEXELS, isSoftwareRenderer } from './terrainPlan';

export interface HoveredTile extends Point {
  /** `null` while the chunk under the pointer hasn't arrived from the worker. */
  info: TileInfo | null;
}

/** Most texels per tile of the rendered terrain at low terrain detail. */
const LOW_DETAIL_TEXELS = 16;

const sameViewport = (a: Viewport | null, b: Viewport): boolean =>
  a !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export class GameView {
  readonly camera = new Camera();
  readonly terrain = new TerrainLayer();
  readonly players = new PlayerLayer();
  /** Entities around the view, from the latest snapshot. */
  readonly entityIndex = new EntityIndex();
  readonly entities = new EntityLayer();
  /** Assembling machines' product icons and working lights. */
  readonly assemblers = new AssemblerLayer();
  /** Steam engine flywheels, turning with their output. */
  readonly generators = new GeneratorLayer();
  /** Belts and the items on them, below the other entities. */
  readonly belts = new BeltLayer();
  /** Inserter arm poses; placeholder arms and what they hold, above the buildings. */
  readonly inserters = new InserterLayer();
  /** Wires between poles, and the supply area / reach overlay of the pole in focus. */
  readonly power = new PowerLayer();
  readonly ghost = new GhostLayer();
  /** The map's colours per chunk (map mode and the minimap), from the snapshots. */
  readonly mapStore = new MapStore();
  /** Map mode: flat colours zoomed out. */
  readonly map = new MapLayer();
  /** Forces map mode on or off whatever the zoom (the render profile compares both); `null` follows the zoom. */
  mapModeOverride: boolean | null = null;
  /** Interpolated player positions from the snapshots. */
  readonly track = new PlayerTrack();
  readonly input: CameraInput;
  /** Whether loading the art (sprites, terrain, icons) has finished, whether or not it worked. */
  artSettled = false;
  /** Whether the camera stays centered on the local player. */
  following = true;
  /**
   * Whether decorative animation runs (the animation setting): belt
   * surfaces, flywheels, machines' working animations and fire. Items,
   * inserter arms and players move either way: they show the game's state.
   */
  animate = true;
  /** Everything positioned in world pixels; transformed by the camera. */
  private readonly world = new Container({ label: 'world' });
  private sentViewport: Viewport | null = null;
  private atlas: SpriteAtlas | null = null;
  /** Map mode's opacity: 0 the sprite view, 1 map mode, in between while fading. */
  private blend = 0;
  /** What map mode replaces: hidden (and not drawn) once it is opaque. */
  private readonly spriteLayers: Container[];

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
      this.belts.coverContainer,
      this.entities.shadowContainer,
      this.power.shadowContainer,
      this.entities.container,
      this.assemblers.container,
      this.generators.container,
      this.inserters.container,
      this.power.container,
      this.entities.iconContainer,
      this.map.container,
      this.players.container,
      this.power.overlayContainer,
      this.belts.overlayContainer,
      this.ghost.container,
    );
    this.spriteLayers = [
      this.terrain.container,
      this.belts.container,
      this.belts.itemContainer,
      this.belts.coverContainer,
      this.entities.shadowContainer,
      this.power.shadowContainer,
      this.entities.container,
      this.assemblers.container,
      this.generators.container,
      this.inserters.container,
      this.power.container,
      this.entities.iconContainer,
    ];
    app.stage.addChild(this.world);
    this.input = new CameraInput(this.camera, app.canvas);
    this.input.onPan = () => {
      this.following = false;
    };
    this.camera.resize(app.screen.width, app.screen.height);
    // A steam engine's sprite runs with its output, like the placeholder flywheel.
    this.entities.sprites.speedOf = (e) =>
      e.type === EntityTypeId.SteamEngine ? (this.generators.speed(e.id) ?? 0) : null;
  }

  /**
   * Draws entities that have a model in `atlas` with its sprites from now on
   * (placeholders for the rest, and for all of them with `null`).
   */
  setSprites(atlas: SpriteAtlas | null): void {
    this.atlas = atlas;
    this.entities.setAtlas(atlas);
    this.ghost.setAtlas(atlas);
    this.assemblers.setAtlas(atlas);
    this.belts.setAtlas(atlas);
    this.inserters.setAtlas(atlas);
    this.power.setAtlas(atlas);
    this.generators.setAtlas(atlas);
  }

  /**
   * Draws the terrain with the rendered look from `art` from now on (the
   * placeholder look for `null`), at most `maxTexels` per tile: by default 64
   * (32 for the base textures, 64 for the detail ones zoomed in),
   * or `SOFTWARE_MAX_TEXELS` on a software renderer, where bakes are slow.
   */
  setTerrainArt(art: TerrainArt | null, maxTexels?: number, lowDetail = false): void {
    const full = this.softwareRendering() ? SOFTWARE_MAX_TEXELS : GPU_MAX_TEXELS;
    // Low detail (the terrain detail setting): a quarter of the texels at most, no detail textures.
    this.terrain.maxTexels =
      maxTexels ?? (lowDetail ? Math.min(LOW_DETAIL_TEXELS, full / 2) : full);
    this.terrain.setArt(art, art ? this.app.renderer : null);
  }

  /**
   * Shows or hides every shadow (the shadows setting): buildings', inserter
   * arms', wires', underground hoods' and, baked again, trees'.
   */
  setShadows(on: boolean): void {
    this.entities.shadowContainer.visible = on;
    this.power.shadowContainer.visible = on;
    this.belts.setShadows(on);
    this.terrain.setShadows(on);
  }

  /** Whether WebGL runs on a software renderer (as in headless browsers and CI). */
  softwareRendering(): boolean {
    return isSoftwareRenderer(this.rendererName());
  }

  /** The WebGL renderer's name (the GPU, or e.g. SwiftShader), `''` if unknown. */
  rendererName(): string {
    const gl = (this.app.renderer as { gl?: WebGL2RenderingContext }).gl;
    if (!gl) return '';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name: unknown = info
      ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return typeof name === 'string' ? name : '';
  }

  /** Names of the sprite models in use (empty without an atlas). */
  spriteModels(): string[] {
    return this.atlas?.modelNames ?? [];
  }

  /** Feeds a snapshot from the worker into the layers. */
  applySnapshot(snapshot: SnapshotMessage): void {
    const arrived = this.terrain.applySnapshot(snapshot.chunkWindow, snapshot.chunks);
    this.mapStore.applyChunks(snapshot.chunkWindow, arrived);
    this.track.push(new Int32Array(snapshot.players), snapshot.ticksRun, performance.now());
    this.entityIndex.apply(snapshot.entities);
    this.mapStore.applyEntities(this.entityIndex);
    this.belts.apply(snapshot.belts, snapshot.tick, performance.now());
    this.inserters.apply(snapshot.inserters, performance.now());
    this.power.apply(snapshot.power);
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

  /**
   * Shows the ghost preview, or hides it for `null`, together with the power
   * overlay of a pole ghost or (with no ghost) of the pole under the pointer,
   * and the reach and partner of an underground belt ghost.
   */
  drawGhost(ghost: Ghost | null): void {
    this.belts.drawOverlay(ghost);
    // An underground belt's ghost shows the hood of what it would be: an entrance or an exit.
    const mode = this.belts.ghostInfo?.mode;
    this.ghost.draw(ghost && mode !== undefined ? { ...ghost, mode } : ghost);
    const tile = this.hoveredTile();
    const hovered = tile && this.entityIndex.at(tile.x, tile.y);
    this.power.drawOverlay(powerFocus(ghost, hovered, this.power.data));
  }

  /**
   * Shows a blueprint's ghosts (D59) in place of the single ghost preview, or
   * the box of a selection being dragged; hides both for `null`.
   */
  drawBlueprint(ghosts: readonly Ghost[] | null, box: TileBoxLike | null): void {
    this.belts.drawOverlay(null);
    this.ghost.draw(ghosts, box);
    this.power.drawOverlay(null);
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
    const view = this.camera.visibleTiles();
    this.mapStore.update();
    this.blend = stepMapBlend(
      this.blend,
      wantsMapMode(this.camera.zoom, this.mapModeOverride),
      dtMs,
    );
    const map = this.map;
    map.container.visible = this.blend > 0;
    map.container.alpha = this.blend;
    if (this.blend > 0) {
      map.sync(
        this.mapStore,
        this.terrain.chunkWindow,
        this.localPlayerPosition(now),
        this.camera.zoom,
      );
    } else if (map.spriteCount > 0) {
      map.clear();
    }
    const sprites = this.blend < 1;
    for (const layer of this.spriteLayers) layer.visible = sprites;
    if (sprites) {
      this.terrain.update(undefined, view, this.camera.zoom);
      // Every entity layer draws only what overlaps the screen (cull.ts).
      const cull = cullRect(view);
      this.belts.animateSurfaces = this.animate;
      this.belts.draw(now, cull);
      const animDt = this.animate ? dtMs : 0;
      // Arm poses first: inserters with sprites are drawn with the buildings;
      // and generators: the engines' sprites take their speed from them.
      this.inserters.draw(now, cull);
      this.generators.draw(this.entityIndex, this.power.data, animDt, cull);
      this.entities.draw(this.entityIndex, animDt, this.inserters.poses, cull);
      this.assemblers.draw(this.entityIndex, animDt, cull);
      this.power.drawWires(cull);
    }
    this.players.draw(this.track, now);
  }

  /** Map mode's opacity: 0 the sprite view, 1 map mode (the sprite layers are hidden), in between while fading. */
  get mapBlend(): number {
    return this.blend;
  }

  /**
   * Whether what is on screen is complete: in map mode, every chunk on
   * screen shown with its current colours; in the sprite view, the terrain
   * baked (`TerrainLayer.isComplete`); never while fading between them.
   */
  viewComplete(): boolean {
    if (this.blend >= 1) {
      return this.map.isComplete(
        this.mapStore,
        this.terrain.chunkWindow,
        this.camera.visibleTiles(),
      );
    }
    return this.blend === 0 && this.terrain.isComplete();
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
