# GPU belt demo: 1M conveyor items on a WebGPU compute shader

A standalone technical demo (#129): one million conveyor items that live entirely in GPU storage buffers. A compute shader moves every item each tick along a looping belt network, and a render pass draws the items straight from the same buffers. The CPU never touches item data after the first upload. It shares no code with the game under `src/` and doesn't change the game.

- Dev server: `npm run dev`, then open <http://localhost:5173/demo/gpu/>.
- Build: `npm run build` writes it to `dist/demo/gpu/` (a second Vite input next to the game's `index.html`). The deploy serves it at `/beltworks-play/demo/gpu/`.
- It needs a browser with WebGPU on a secure page (https or `localhost`). Without WebGPU, or without a GPU adapter, the page shows a message instead.
- [`docs/screenshots/gpu-demo-1m.png`](../../docs/screenshots/gpu-demo-1m.png): one million items, headless on SwiftShader.

| URL parameter | Effect |
|---|---|
| `?n=` | Item count. Default 1 000 000, capped by the device's limits (the overlay says when it was capped) |
| `?quads=` | Item quads per instance of the item draw (default 64; `1` is one quad per instance). See "Render" |
| `?paused=1` | Don't step on its own. The tests step through `window.__gpuDemo` |

## Files

| File | What it holds |
|---|---|
| `network.ts` | The belt network as plain data, one `Uint32Array` |
| `sim.ts` | The item layout, the initial state, the pure-TS reference step and the reference counters |
| `shaders.ts` | WGSL: the step and count compute shaders, and the belt and item render shaders |
| `gpu.ts` | `GpuBeltSim`: buffers, pipelines, bind groups, stepping, drawing and readback |
| `main.ts` | The page: device setup, the frame loop, the overlay and the test hook |

## The belt network

445 one-tile segments in three paths: a **trunk** (express belts) that ends on a **splitter**, whose straight output is **branch A** (fast belts, round the outside) and whose turning output is **branch B** (slow belts, a serpentine through the middle). Both branches end in a **merge** into the trunk's first tile, so the network is one loop. A segment is one tile crossed in a fixed direction: straight when its entry and exit directions match, a corner (drawn as a quarter-circle arc) when they don't. The splitter's output tile and the merge tile each hold two segments, one per branch.

Each segment is 8 `u32` words, uploaded unchanged as an `array<Segment>` storage buffer:

| Word | Field | Meaning |
|---|---|---|
| 0, 1 | `x`, `y` | Tile |
| 2, 3 | `inDir`, `outDir` | Direction of travel into and out of the tile (0 east, 1 south, 2 west, 3 north) |
| 4, 5 | `next0`, `next1` | Successor segments. They differ only on the splitter's input |
| 6 | `speed` | Progress units per tick: 2048, 4096 or 6144 (the game's three belt tiers at 60 ticks/s) |
| 7 | `group` | Path: 0 trunk, 1 branch A, 2 branch B |

## Item buffers

Structure of arrays, one `u32` per item in each buffer. No per-item JavaScript objects exist, not even at start: `initItems` fills three typed arrays that are uploaded once.

| Buffer | Content | Buffers |
|---|---|---|
| `belt` | Segment index | 2 (ping-pong) |
| `progress` | Position along the segment, 16.16 fixed point: 65 536 units are one tile | 2 (ping-pong) |
| `itemType` | Color, 0 to 3. Never changes | 1 |
| `counters` | 8 atomic `u32`: items per path (3), items per type (4), checksum | 1, plus a mappable copy |

At one million items, the five item buffers hold 20 MB. Each must fit in one storage binding and one buffer, and the step dispatches one thread per item in 256-thread workgroups along one dimension. So the item count is capped at the smallest of `maxStorageBufferBindingSize / 4`, `maxBufferSize / 4` and `maxComputeWorkgroupsPerDimension * 256` (16.7 M on default limits). The page asks the adapter for its largest storage binding and buffer sizes.

## Data flow

Each frame, `main.ts` steps as many ticks as the elapsed time asks for (60 per second, at most 4 per frame, so a slow device runs slower instead of stalling), then draws:

1. **Step** (compute, one pass per tick). Thread `i` reads `belt[i]` and `progress[i]` from buffer *k*, adds the segment's speed, and on reaching 65 536 subtracts it and moves to `next0` or `next1`. It writes buffer *1 - k*, and the next tick reads that one. Up to 64 ticks are encoded in one submission. Each tick's number sits in its own 256-byte slot of a uniform buffer, picked with a dynamic offset. The splitter output is `mix32(i ^ mix32(tick)) & 1`: deterministic, and about half the items take each output.
2. **Render** (one render pass). Belts are drawn first: one instanced quad per segment. Then items: the vertex shader reads `belt`, `progress` and `itemType` of the current buffer *k* through read-only storage bindings, places the item on the straight line or the corner's arc, and spreads items across the belt's width by a per-item hash. Nothing is uploaded per frame except a 32-byte view uniform.
3. **Counters** (twice a second). A compute pass adds every item's path, type and checksum term into the `counters` buffer with atomic adds, so the order doesn't matter. The buffer is copied to a mappable buffer and read with `mapAsync`, with at most one readback in flight. These 32 bytes are the only data read back. The overlay shows them with the tick they describe.

**Determinism.** All state is integer, and every speed is below one tile, so an item crosses at most one boundary per tick. Items don't interact (there's no belt compression or blocking), so each item depends only on its own state, and any execution order gives the same result. `sim.ts` implements the same step in TypeScript (`referenceStep`, with `Math.imul` for WGSL's wrapping `u32` multiply), and the tests compare the two bit for bit.

**Render.** The item draw is instanced, and each instance draws `QUADS` items' quads as a triangle list: item `instance * QUADS + vertex / 6`. `?quads=1` is the textbook one quad per instance. Batching 64 per instance gives the same picture (a test checks this) and avoids a per-instance cost: SwiftShader runs an instanced draw as a loop over instances, which made one quad per instance about ten times slower there.

## Tests

- `tests/gpu/demo.test.ts` (in `npm test`) checks the CPU side. The network is one connected loop with one splitter and one merge, every link enters the right neighbor tile, and the reference step advances, conserves and splits items deterministically. It also covers the limits and view helpers.
- `tests/gpu/gpuDemo.spec.ts` (`npm run test:gpu`, `playwright.gpu.config.ts`) runs headless Chromium with WebGPU on SwiftShader, against the production build under `/beltworks-play/`:
  - For 1, 255, 1000 and 4099 items, the GPU state after 1, 38, 102, 232 and 500 steps (in uneven batches across the 64-step submissions) equals `referenceRun` exactly, and the GPU counters equal `referenceCounters`.
  - One quad per instance and 64 per instance draw identical pictures.
  - At one million items, items cover the picture and move between two screenshots. The second screenshot goes to `test-results/`.
  - Without `navigator.gpu`, the page shows its message.

  `GPU_CHROME` points Playwright at another Chromium binary or a wrapper script. The config passes `--enable-unsafe-webgpu --use-angle=swiftshader --use-webgpu-adapter=swiftshader --no-sandbox --ignore-gpu-blocklist`, plus `--enable-features=Vulkan --use-vulkan=swiftshader`. With only the first set, SwiftShader's WebGPU can compute, but presenting a canvas loses the device. It isn't part of CI. On SwiftShader, one million items draw at about 1.5 to 2 frames per second, which the test allows for. Correctness is the point there, not speed.
