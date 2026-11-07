/**
 * The rendered terrain (docs/ART.md, "Terrain"): bakes a chunk's plan
 * (terrainPlan.ts) into a texture on the GPU.
 *
 * The ground is one quad drawn with a small shader that samples the four
 * seamless ground textures from the `terrain` atlas by world position and
 * blends them with the chunk's splat texture: smooth (half cubic B-spline)
 * weights between tile centers, pushed around by value noise so the edges
 * between terrain types wander instead of following the grid, then
 * sharpened to a soft band. It
 * also darkens sand near water (wet), lightens shallow water and adds a faint
 * foam line at the shore, and lays a slow brightness and hue variation over
 * everything so the textures' 8-tile period doesn't show. On top come the
 * ore decals and decor, the trees' shadows (drawn at full strength into one
 * faded layer, like the entities' shadows, so overlapping shadows don't get
 * darker), and the trees from north to south. Ore patches get a noisy
 * outline from a second splat texture: the ground pass stains the soil inside
 * it, and a second pass of the same shader over the patches' edge tiles,
 * right after the decals, draws the ground again outside it, so a patch's
 * edge doesn't step along the tile grid.
 *
 * A bake is one draw of the ground plus a few hundred sprites into a render
 * texture, so it costs well under a millisecond of GPU time and almost no
 * CPU: no pixel buffers on the main thread.
 *
 * Read-only: nothing here flows back into the simulation.
 */

import {
  Assets,
  BufferImageSource,
  Container,
  GlProgram,
  Mesh,
  MeshGeometry,
  RenderTexture,
  Shader,
  Sprite,
  type Renderer,
  type Texture,
} from 'pixi.js';
import { CHUNK_SIZE } from '../sim/world/chunk';
import { placeSprite } from './entitySprites';
import { SHADOW_ALPHA, SpriteAtlas, loadAtlasFiles, type ModelSprites } from './sprites';
import { SPLAT_BORDER, SPLAT_SIZE, type ChunkPlan } from './terrainPlan';

/** The ground textures, in the order of the splat channels (rock last: what the others leave). */
export const GROUND_NAMES = ['grass', 'sand', 'water', 'rock'] as const;

const VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vTile;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uChunkSize;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vTile = aUV * uChunkSize;
}
`;

const FRAGMENT = /* glsl */ `
// Lattice positions reach a few hundred: mediump would lose the fraction.
precision highp float;
in vec2 vTile;
out vec4 finalColor;
uniform sampler2D uGrass;
uniform sampler2D uSand;
uniform sampler2D uWater;
uniform sampler2D uRock;
uniform sampler2D uSplat;
uniform sampler2D uOre;
uniform sampler2D uNoise;
uniform vec2 uChunk;
uniform float uPeriod;
uniform float uSplatSize;
uniform float uSplatBorder;
uniform float uChunkSize;
uniform float uCover;

const float NOISE_SIZE = 256.0;

// Value noise from a random lattice texture, CELLS lattice cells per chunk
// (a whole number, so neighbouring chunks continue each other exactly; the
// lattice repeats every NOISE_SIZE cells). One smoothstepped bilinear tap
// gives four independent fields.
vec4 lattice(float cells, vec2 seed) {
  vec2 p = mod(uChunk * cells, NOISE_SIZE) + vTile * (cells / uChunkSize) + seed;
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(uNoise, (i + f + 0.5) / NOISE_SIZE);
}

vec4 fbm(float cells, vec2 seed) {
  return lattice(cells, seed) * 0.6 + lattice(cells * 2.0, seed + vec2(37.0, 11.0)) * 0.28 +
         lattice(cells * 4.0, seed + vec2(91.0, 53.0)) * 0.12;
}

// A splat texture at a tile position: halfway between bilinear (which keeps
// lone tiles) and a cubic B-spline (four bilinear taps; smooth, so a diagonal
// edge of tiles becomes a line instead of a staircase).
vec4 smoothSplat(sampler2D tex, vec2 tile) {
  vec2 t = tile + uSplatBorder;
  vec4 linear = texture(tex, t / uSplatSize);
  vec2 p = t - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / uSplatSize;
  vec2 h1 = (i + 1.5 + w3 / g1) / uSplatSize;
  vec4 cubic = g0.y * (g0.x * texture(tex, h0) + g1.x * texture(tex, vec2(h1.x, h0.y))) +
               g1.y * (g0.x * texture(tex, vec2(h0.x, h1.y)) + g1.x * texture(tex, h1));
  return mix(linear, cubic, 0.6);
}

void main() {
  vec3 s = smoothSplat(uSplat, vTile).rgb;
  vec4 wt = vec4(s, max(0.0, 1.0 - s.r - s.g - s.b));
  // Push the blend around with noise (one field per type: a broad one a few
  // tiles across, so edges meander, and a fine one about a tile across),
  // then keep only the strongest type, with a soft band where two are close.
  vec4 n = (fbm(uChunkSize * 1.25, vec2(0.0)) - 0.5) * 0.45 +
           (lattice(uChunkSize * 0.25, vec2(61.0, 29.0)) - 0.5) * 0.4;
  vec4 score = mix(vec4(-9.0), wt + n, step(0.002, wt));
  float top = max(max(score.x, score.y), max(score.z, score.w));
  vec4 f = clamp((score - top) / 0.09 + 1.0, 0.0, 1.0);
  f /= dot(f, vec4(1.0));

  // Chunks start on a multiple of the period, so local tiles index the textures.
  vec2 uv = vTile / uPeriod;
  vec3 grass = texture(uGrass, uv).rgb;
  vec3 sand = texture(uSand, uv).rgb;
  vec3 water = texture(uWater, uv).rgb;
  vec3 rock = texture(uRock, uv).rgb;

  // How much water is around (the splat's alpha: water over the 3x3 tiles
  // around): shallow and wet near the shore.
  vec4 splat = texture(uSplat, (vTile + uSplatBorder) / uSplatSize);
  float wet = wt.b * 0.5 + splat.a * 0.5;
  sand *= 1.0 - 0.22 * smoothstep(0.1, 0.6, wet);
  water = mix(water * 1.35 + vec3(0.03, 0.07, 0.06), water * 0.92, smoothstep(0.55, 0.95, wet));

  // Slow drifts: grass between greener and yellower, and light and dark over
  // everything, so the textures' period doesn't show.
  vec4 slow = lattice(1.0, vec2(5.0, 9.0)) * 0.6 + lattice(2.0, vec2(17.0, 3.0)) * 0.4;
  grass = mix(grass, grass * vec3(1.1, 1.04, 0.82), smoothstep(0.45, 0.8, slow.x) * 0.4);

  vec3 color = grass * f.x + sand * f.y + water * f.z + rock * f.w;
  // Foam where water meets land.
  float shore = f.z * (1.0 - f.z) * 4.0;
  color = mix(color, vec3(0.86, 0.9, 0.86), shore * 0.18);
  color *= 0.88 + 0.2 * slow.y;

  // Ore patches: a noisy outline around the ore tiles (tile centers always
  // stay on their side). Outside the tiles with ore it stains the soil the
  // way the decals do; on the edge tiles (the cover pass, drawn after the
  // decals) the ground covers the decals outside the outline.
  float alpha = 1.0;
  vec4 oreNear = texture(uOre, (vTile + uSplatBorder) / uSplatSize);
  if (uCover > 0.5 || dot(oreNear, vec4(1.0)) > 0.0) {
    vec4 ore = smoothSplat(uOre, vTile);
    float amount = dot(ore, vec4(1.0));
    float on = (fbm(uChunkSize * 0.9, vec2(23.0, 71.0)).x - 0.5) * 0.5 +
               (lattice(uChunkSize * 0.25, vec2(43.0, 7.0)).y - 0.5) * 0.45;
    float inside = smoothstep(0.44, 0.56, amount + on);
    vec3 stain = (ore.r * vec3(0.29, 0.31, 0.31) + ore.g * vec3(0.35, 0.29, 0.22) +
                  ore.b * vec3(0.16, 0.16, 0.15) + ore.a * vec3(0.48, 0.44, 0.37)) /
                 max(amount, 0.001);
    vec2 own = (floor(vTile) + uSplatBorder + 0.5) / uSplatSize;
    float ownOre = dot(texture(uOre, own), vec4(1.0));
    color = mix(color, color * 0.55 + stain * 0.45, inside * (1.0 - ownOre) * 0.75);
    // Over the decals: cover them outside the outline on ore tiles, and
    // everywhere off them (their stain spills a little past the tile).
    alpha = mix(1.0, 1.0 - inside, ownOre);
  }
  if (uCover < 0.5) alpha = 1.0;
  else if (alpha < 0.004) discard;
  finalColor = vec4(color * alpha, alpha);
}
`;

/** Edge of the random lattice texture the ground shader's noise reads. */
const NOISE_SIZE = 256;

/** `NOISE_SIZE`² random RGBA texels, the same every time (a fixed-seed generator). */
function noiseLattice(): Uint8Array {
  const out = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
  let state = 0x5eed1e55;
  for (let i = 0; i < out.length; i++) {
    // mulberry32
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = (t ^ (t >>> 14)) & 0xff;
  }
  return out;
}

/** One loaded terrain atlas: ground textures, decal / tree models, and the shader. */
export class TerrainArt {
  private readonly splat: BufferImageSource;
  private readonly splatPixels = new Uint8Array(SPLAT_SIZE * SPLAT_SIZE * 4);
  private readonly ore: BufferImageSource;
  private readonly orePixels = new Uint8Array(SPLAT_SIZE * SPLAT_SIZE * 4);
  private readonly noise = new BufferImageSource({
    resource: noiseLattice(),
    width: NOISE_SIZE,
    height: NOISE_SIZE,
    scaleMode: 'linear',
    addressMode: 'repeat',
    label: 'terrain noise',
  });
  private readonly mesh: Mesh<MeshGeometry, Shader>;
  /** The ore outline over the decals: a quad per ore edge tile (the rest degenerate). */
  private readonly cover: Mesh<MeshGeometry, Shader>;
  private readonly coverIndices = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE * 6);
  private readonly root = new Container({ label: 'terrain-bake' });
  private readonly decals = new Container();
  private readonly shadows = new Container();
  private readonly trees = new Container();
  private readonly pools: Sprite[][] = [[], [], []];

  constructor(
    ground: Texture[],
    period: number,
    readonly models: SpriteAtlas,
  ) {
    this.splat = new BufferImageSource({
      resource: this.splatPixels,
      width: SPLAT_SIZE,
      height: SPLAT_SIZE,
      scaleMode: 'linear',
      // Alpha holds data (how wet), not coverage: upload it as it is.
      alphaMode: 'no-premultiply-alpha',
      label: 'terrain splat',
    });
    this.ore = new BufferImageSource({
      resource: this.orePixels,
      width: SPLAT_SIZE,
      height: SPLAT_SIZE,
      scaleMode: 'linear',
      alphaMode: 'no-premultiply-alpha',
      label: 'terrain ore',
    });
    const glProgram = new GlProgram({ vertex: VERTEX, fragment: FRAGMENT, name: 'terrain-ground' });
    const shader = (cover: boolean) =>
      new Shader({
        glProgram,
        resources: {
          terrainUniforms: {
            uChunk: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
            uPeriod: { value: period, type: 'f32' },
            uSplatSize: { value: SPLAT_SIZE, type: 'f32' },
            uSplatBorder: { value: SPLAT_BORDER, type: 'f32' },
            uChunkSize: { value: CHUNK_SIZE, type: 'f32' },
            uCover: { value: cover ? 1 : 0, type: 'f32' },
          },
          uGrass: ground[0]!.source,
          uSand: ground[1]!.source,
          uWater: ground[2]!.source,
          uRock: ground[3]!.source,
          uSplat: this.splat,
          uOre: this.ore,
          uNoise: this.noise,
        },
      });
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    this.mesh = new Mesh({ geometry, shader: shader(false) });
    // The cover mesh: a fixed grid of one quad per tile (in chunk units, like
    // the ground quad); each bake only rewrites the indices, to the tiles on
    // the edges of ore patches.
    const grid = new Float32Array(CHUNK_SIZE * CHUNK_SIZE * 8);
    for (let t = 0; t < CHUNK_SIZE * CHUNK_SIZE; t++) {
      const x0 = (t % CHUNK_SIZE) / CHUNK_SIZE;
      const y0 = Math.floor(t / CHUNK_SIZE) / CHUNK_SIZE;
      const x1 = x0 + 1 / CHUNK_SIZE;
      const y1 = y0 + 1 / CHUNK_SIZE;
      grid.set([x0, y0, x1, y0, x1, y1, x0, y1], t * 8);
    }
    this.cover = new Mesh({
      geometry: new MeshGeometry({
        positions: grid,
        uvs: grid.slice(),
        indices: this.coverIndices,
      }),
      shader: shader(true),
    });
    // Tree shadows at the entities' shadow strength. Drawn straight onto the
    // ground (no faded layer, which costs a full extra pass per bake): where
    // two overlap, under dense forest, they darken a little more.
    this.shadows.alpha = SHADOW_ALPHA;
    this.root.addChild(this.mesh, this.decals, this.cover, this.shadows, this.trees);
  }

  /** The model of a decal or tree, or `null` if the atlas lacks it. */
  model(name: string): ModelSprites | null {
    return this.models.model(name);
  }

  /**
   * Draws `plan` for the chunk whose top-left tile is world `(x0, y0)` into
   * `target` (`texels` per tile).
   */
  bake(
    renderer: Renderer,
    plan: ChunkPlan,
    x0: number,
    y0: number,
    texels: number,
    target: RenderTexture,
  ): void {
    this.splatPixels.set(plan.splat);
    this.splat.update();
    this.orePixels.set(plan.ore);
    this.ore.update();
    // The chunk's place in the noise lattice, which repeats every NOISE_SIZE cells.
    const wrap = (tile: number) =>
      ((Math.floor(tile / CHUNK_SIZE) % NOISE_SIZE) + NOISE_SIZE) % NOISE_SIZE;
    for (const mesh of [this.mesh, this.cover]) {
      const uniforms = mesh.shader!.resources.terrainUniforms as {
        uniforms: { uChunk: Float32Array };
      };
      uniforms.uniforms.uChunk[0] = wrap(x0);
      uniforms.uniforms.uChunk[1] = wrap(y0);
    }
    const size = CHUNK_SIZE * texels;
    this.mesh.scale.set(size);
    this.cover.scale.set(size);
    const indices = this.coverIndices;
    indices.fill(0);
    plan.oreEdges.forEach((t, k) => {
      const v = t * 4;
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], k * 6);
    });
    this.cover.geometry.indexBuffer.update();
    this.cover.visible = plan.oreEdges.length > 0;
    let shadowCount = 0;
    const place = (
      pool: number,
      layer: Container,
      used: number,
      frame: Parameters<typeof placeSprite>[1],
      scale: number,
      x: number,
      y: number,
    ) => {
      const sprites = this.pools[pool]!;
      let sprite = sprites[used];
      if (!sprite) {
        sprite = new Sprite();
        sprites.push(sprite);
        layer.addChild(sprite);
      }
      sprite.visible = true;
      placeSprite(sprite, frame, scale, x * texels, y * texels);
    };
    let decalCount = 0;
    for (const d of plan.decals) {
      const model = this.models.model(d.name);
      if (!model) continue;
      place(0, this.decals, decalCount++, model.layers[0]!.frames[0]![0]!, texels / 64, d.x, d.y);
    }
    let treeCount = 0;
    for (const t of plan.trees) {
      const model = this.models.model(t.name);
      if (!model) continue;
      place(1, this.shadows, shadowCount++, model.shadow[0]!, texels / 64, t.x, t.y);
      place(2, this.trees, treeCount++, model.layers[0]!.frames[0]![0]!, texels / 64, t.x, t.y);
    }
    const hide = (pool: number, from: number) => {
      const sprites = this.pools[pool]!;
      for (let i = from; i < sprites.length; i++) sprites[i]!.visible = false;
    };
    hide(0, decalCount);
    hide(1, shadowCount);
    hide(2, treeCount);
    renderer.render({ container: this.root, target, clear: true, clearColor: [0, 0, 0, 1] });
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.splat.destroy();
    this.ore.destroy();
  }
}

/**
 * Loads the terrain atlas at `url` (its models, and its ground textures as
 * repeating, mipmapped textures); `null` if it can't, and the terrain keeps
 * its placeholder look.
 */
export async function loadTerrainArt(url: string): Promise<TerrainArt | null> {
  const files = await loadAtlasFiles(url);
  if (!files) return null;
  try {
    const entries = GROUND_NAMES.map((name) => files.index.ground?.[name]);
    if (entries.some((e) => !e) || new Set(entries.map((e) => e!.period)).size !== 1) {
      throw new Error('the terrain atlas needs grass, sand, water and rock of one period');
    }
    const ground = await Promise.all(
      entries.map((e) =>
        Assets.load<Texture>({
          src: files.base + e!.file,
          data: { autoGenerateMipmaps: true, scaleMode: 'linear', addressMode: 'repeat' },
        }),
      ),
    );
    return new TerrainArt(ground, entries[0]!.period, new SpriteAtlas(files.index, files.sheets));
  } catch (err) {
    console.warn('terrain: falling back to placeholders:', err);
    return null;
  }
}
