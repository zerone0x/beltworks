/**
 * The demo's WGSL: the step and count compute shaders, and the render shaders
 * that draw belts and items straight from the storage buffers. The step and
 * the counters must stay identical to `referenceStep` and `referenceCounters`
 * in `sim.ts`.
 */

import { COUNTER_WORDS, Counter } from './sim';
import { NO_SEGMENT, SEGMENT_LENGTH } from './network';

/** Threads per compute workgroup. */
export const WORKGROUP_SIZE = 256;

/** Byte stride of the per-step uniforms (dynamic offsets must be 256-byte aligned). */
export const STEP_UNIFORM_STRIDE = 256;

const common = /* wgsl */ `
struct Segment {
  x: u32,
  y: u32,
  inDir: u32,
  outDir: u32,
  next0: u32,
  next1: u32,
  speed: u32,
  group: u32,
}

const SEGMENT_LENGTH: u32 = ${String(SEGMENT_LENGTH)}u;
const NO_SEGMENT: u32 = ${String(NO_SEGMENT)}u;

// lowbias32, the same as mix32 in sim.ts.
fn mix32(v: u32) -> u32 {
  var x = v;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
`;

/** One tick for every item: reads one buffer of the pair, writes the other. */
export const stepShader = /* wgsl */ `
${common}
override ITEMS: u32;

// x: the tick being stepped. One 256-byte slot per step of a batch (dynamic offset).
@group(0) @binding(0) var<uniform> params: vec4u;
@group(0) @binding(1) var<storage, read> segments: array<Segment>;
@group(0) @binding(2) var<storage, read> beltIn: array<u32>;
@group(0) @binding(3) var<storage, read> progressIn: array<u32>;
@group(0) @binding(4) var<storage, read_write> beltOut: array<u32>;
@group(0) @binding(5) var<storage, read_write> progressOut: array<u32>;

@compute @workgroup_size(${String(WORKGROUP_SIZE)})
fn step(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= ITEMS) {
    return;
  }
  var b = beltIn[i];
  let s = segments[b];
  var p = progressIn[i] + s.speed;
  if (p >= SEGMENT_LENGTH) {
    let output = mix32(i ^ mix32(params.x)) & 1u;
    let next = select(s.next0, s.next1, output == 1u);
    if (next == NO_SEGMENT) {
      // A dead end (an edited belt that leads nowhere): the item waits at the end.
      p = SEGMENT_LENGTH - 1u;
    } else {
      p -= SEGMENT_LENGTH;
      b = next;
    }
  }
  beltOut[i] = b;
  progressOut[i] = p;
}
`;

/** The aggregate counters (see `Counter` in sim.ts): atomic adds, so the order doesn't matter. */
export const countShader = /* wgsl */ `
${common}
override ITEMS: u32;

@group(0) @binding(0) var<storage, read> segments: array<Segment>;
@group(0) @binding(1) var<storage, read> belt: array<u32>;
@group(0) @binding(2) var<storage, read> progress: array<u32>;
@group(0) @binding(3) var<storage, read> itemType: array<u32>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>, ${String(COUNTER_WORDS)}>;

@compute @workgroup_size(${String(WORKGROUP_SIZE)})
fn count(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= ITEMS) {
    return;
  }
  let b = belt[i];
  atomicAdd(&counters[${String(Counter.groups)}u + segments[b].group], 1u);
  atomicAdd(&counters[${String(Counter.types)}u + itemType[i]], 1u);
  atomicAdd(&counters[${String(Counter.checksum)}u], mix32(i ^ mix32(b ^ mix32(progress[i]))));
}
`;

const view = /* wgsl */ `
// Tile coordinates to clip space: clip = tile * scale + offset. half: an item's half size in clip space.
struct View {
  scale: vec2f,
  offset: vec2f,
  half: vec2f,
  pad: vec2f,
}

@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> segments: array<Segment>;

// Quad corner v (0..3, strip order) in [-1, 1]. Arithmetic rather than lookup tables:
// software rasterizers (SwiftShader) run function-local arrays far slower.
fn corner(v: u32) -> vec2f {
  return vec2f(f32(v & 1u), f32(v >> 1u)) * 2.0 - 1.0;
}

// DIRS in network.ts: east, south, west, north.
fn dir(d: u32) -> vec2f {
  return vec2f(f32(d == 0u) - f32(d == 2u), f32(d == 1u) - f32(d == 3u));
}
`;

/** The item shader's vertex output and its flat-colored fragment. */
const itemOut = /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
`;

/**
 * One instanced quad (a 4-vertex triangle strip) per segment: the belt tiles
 * under the items. Each tile is shaded in its own frame (along its exit
 * direction): dark side rails, and chevrons pointing the way the items go.
 * A dead end (a belt edited to lead nowhere) is tinted red.
 */
export const beltShader = /* wgsl */ `
${common}
${view}

struct BeltOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  // The point in the tile's own frame: x along the exit direction, y across, both in [-0.5, 0.5].
  @location(1) local: vec2f,
  @location(2) @interpolate(flat) deadEnd: u32,
}

@vertex
fn vertexMain(@builtin(vertex_index) v: u32, @builtin(instance_index) s: u32) -> BeltOut {
  let seg = segments[s];
  let center = vec2f(f32(seg.x), f32(seg.y)) + vec2f(0.5);
  let c = corner(v) * 0.5;
  let p = center + c;
  let along = dir(seg.outDir);
  var out: BeltOut;
  out.position = vec4f(p * view.scale + view.offset, 0.0, 1.0);
  out.local = vec2f(dot(c, along), dot(c, vec2f(-along.y, along.x)));
  out.deadEnd = u32(seg.next0 == NO_SEGMENT);
  // By path: trunk, branch A, branch B.
  out.color = select(
    select(vec3f(0.27, 0.25, 0.17), vec3f(0.30, 0.20, 0.20), seg.group == 1u),
    vec3f(0.20, 0.24, 0.32),
    seg.group == 0u,
  );
  return out;
}

@fragment
fn fragmentMain(input: BeltOut) -> @location(0) vec4f {
  var color = input.color;
  if (input.deadEnd == 1u) {
    color = vec3f(0.42, 0.14, 0.14);
  }
  let across = abs(input.local.y);
  // Chevrons: three per tile, pointing along the exit direction.
  let k = fract((input.local.x - across * 0.8) * 3.0);
  if (across > 0.4) {
    color *= 0.55;
  } else if (k < 0.22) {
    color *= 1.3;
  }
  return vec4f(color, 1.0);
}
`;

/**
 * Instanced quads, one per item, positioned from the item's segment and
 * progress read straight from the storage buffers the step wrote: no item
 * data goes through the CPU. Corners are quarter-circle arcs.
 *
 * Each instance draws `QUADS` items' quads as a triangle list (6 vertices
 * each): item `instance * QUADS + vertex / 6`. With `QUADS = 1` it is the
 * textbook one quad per instance; batching cuts the per-instance overhead,
 * which software renderers (SwiftShader loops over instances) pay per item.
 */
export const itemShader = /* wgsl */ `
${common}
${view}
${itemOut}

override ITEMS: u32;
override QUADS: u32 = 1u;

@group(0) @binding(2) var<storage, read> belt: array<u32>;
@group(0) @binding(3) var<storage, read> progress: array<u32>;
@group(0) @binding(4) var<storage, read> itemType: array<u32>;

@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  var out: VertexOut;
  let i = instance * QUADS + vertex / 6u;
  if (i >= ITEMS) {
    // Past the last item in the last instance: a degenerate triangle outside the view.
    out.position = vec4f(2.0, 2.0, 0.0, 1.0);
    out.color = vec3f(0.0);
    return out;
  }
  // Triangle-list vertex 0..5 to strip corner 0, 1, 2, 2, 1, 3.
  let k = vertex % 6u;
  let v = select(select(select(3u, 1u, k == 4u), 2u, k == 3u), k, k < 3u);
  let seg = segments[belt[i]];
  let f = f32(progress[i]) / f32(SEGMENT_LENGTH);
  let din = dir(seg.inDir);
  let dout = dir(seg.outDir);
  let entry = vec2f(f32(seg.x), f32(seg.y)) + vec2f(0.5) - 0.5 * din;
  var pos: vec2f;
  var tangent: vec2f;
  if (seg.inDir == seg.outDir) {
    pos = entry + din * f;
    tangent = din;
  } else {
    let a = f * 1.5707964;
    let pivot = entry + 0.5 * dout;
    pos = pivot + 0.5 * (din * sin(a) - dout * cos(a));
    tangent = din * cos(a) + dout * sin(a);
  }
  // Spread items across the belt's width by a per-item hash.
  let h = mix32(i);
  let lateral = (f32(h >> 8u) / 16777216.0 - 0.5) * 0.72;
  pos += vec2f(-tangent.y, tangent.x) * lateral;

  let t = itemType[i];
  let color = select(
    select(vec3f(0.55, 0.90, 0.45), vec3f(0.95, 0.40, 0.45), t == 2u),
    select(vec3f(0.35, 0.80, 0.95), vec3f(0.95, 0.75, 0.25), t == 0u),
    t < 2u,
  );
  let shade = 0.8 + 0.2 * f32(h & 255u) / 255.0;
  out.position = vec4f(pos * view.scale + view.offset + corner(v) * view.half, 0.0, 1.0);
  out.color = color * shade;
  return out;
}
`;
