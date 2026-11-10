# GPU belt demo: 1M conveyor items on a WebGPU compute shader

A standalone technical demo (#129, #130, #131): one million conveyor items that live entirely in GPU storage buffers. A compute shader moves every item each tick along a looping belt network, and a render pass draws the items straight from the same buffers. The CPU never touches item data after the first upload. It shares no code with the game under `src/` and doesn't change the game.

- Dev server: `npm run dev`, then open <http://localhost:5173/demo/gpu/>.
- Build: `npm run build` writes it to `dist/demo/gpu/` (a second Vite input next to the game's `index.html`). The deploy serves it at `/beltworks-play/demo/gpu/`.
- It needs a browser with WebGPU on a secure page (https or `localhost`). Without WebGPU, or without a GPU adapter, the page shows a message instead.
- [`docs/screenshots/gpu-demo-1m.png`](../../docs/screenshots/gpu-demo-1m.png): one million items, headless on SwiftShader.
- [`docs/screenshots/gpu-film-*.png`](../../docs/screenshots/): stills from the film (see "The film"), one million items.

Drag to pan, scroll (or `+` and `-`) to zoom, `0` to see the whole factory again, arrow keys to pan. Click a belt to rotate it, or an empty tile to place a belt (see "Belt editing").

| URL parameter | Effect |
|---|---|
| `?n=` | Item count. Default 1 000 000, capped by the device's limits (the overlay says when it was capped) |
| `?quads=` | Item quads per instance of the item draw (default 64; `1` is one quad per instance). See "Render" |
| `?paused=1` | Don't step on its own. The tests step through `window.__gpuDemo` |
| `?capture=1` | Capture mode: no frame loop and no clock. `window.__step(k)` steps exactly `k` ticks, draws one frame and resolves when the GPU is done. See "Capture and benchmark" |
| `?timing=0` | Leave the measured step time out of the overlay (it still says which clock would time it), so the same ticks always give the same picture |
| `?camera=film` | Capture mode only: the scripted film camera, captions, clicks and end card, a function of the tick. See "The film" |
| `?filmticks=` | The film's length in ticks (default 1440). The script is laid out over it |

## Files

| File | What it holds |
|---|---|
| `network.ts` | The belt network as plain data, one `Uint32Array` |
| `sim.ts` | The item layout, the initial state, the pure-TS reference step and the reference counters |
| `shaders.ts` | WGSL: the step and count compute shaders, and the belt and item render shaders |
| `gpu.ts` | `GpuBeltSim`: buffers, pipelines, bind groups, stepping, drawing, segment updates and readback |
| `camera.ts` | The camera (pan, zoom, tile and pixel mappings) and the film script (`filmShot`, `filmEdits`) |
| `edit.ts` | `EditableNetwork`: the network with free segment slots, and the click rule that places and rotates belts |
| `main.ts` | The page: device setup, the frame loop, input, the overlay, the film overlays and the test hook |
| `tools/gpu-demo/` | The capture, assemble and benchmark scripts (Node, Playwright). See "Capture and benchmark" |

## The belt network

445 one-tile segments in three paths: a **trunk** (express belts) that ends on a **splitter**, whose straight output is **branch A** (fast belts, round the outside) and whose turning output is **branch B** (slow belts, a serpentine through the middle). Both branches end in a **merge** into the trunk's first tile, so the network is one loop. A segment is one tile crossed in a fixed direction: straight when its entry and exit directions match, a corner (drawn as a quarter-circle arc) when they don't. The splitter's output tile and the merge tile each hold two segments, one per branch.

Each segment is 8 `u32` words, uploaded unchanged as an `array<Segment>` storage buffer:

| Word | Field | Meaning |
|---|---|---|
| 0, 1 | `x`, `y` | Tile |
| 2, 3 | `inDir`, `outDir` | Direction of travel into and out of the tile (0 east, 1 south, 2 west, 3 north) |
| 4, 5 | `next0`, `next1` | Successor segments. They differ only on the splitter's input. `0xffffffff` (`NO_SEGMENT`) is a dead end, which only an edit makes |
| 6 | `speed` | Progress units per tick: 2048, 4096 or 6144 (the game's three belt tiers at 60 ticks/s) |
| 7 | `group` | Path: 0 trunk, 1 branch A, 2 branch B |

## Camera

`camera.ts` keeps a center in tile coordinates and a zoom relative to the view that fits the whole network into the area under the overlay (zoom 1 is exactly the old fixed view). The render transform is still the 32-byte view uniform, so panning and zooming upload nothing else. Zoom goes from 0.5 to 32. Items are a twelfth of a tile, between 1.5 and 6 pixels across, so a close view still shows single items. Belts are drawn first, under the items: each tile is shaded in the frame of its exit direction, with dark side rails and chevrons that point the way items move, tinted by path (trunk blue, branch A red, branch B olive) and red for a dead end. Items are colored by type.

## Belt editing

A click on the canvas (a press and release that moves less than 4 pixels; more is a pan) edits the tile under it (`EditableNetwork.edit`):

- **A tile with one belt:** the belt's exit turns: straight, then a right turn, then a left turn, then straight again. The belt is relinked to the segment on the next tile that is entered in the new exit direction, or to `NO_SEGMENT` if there is none. Its entry can't change, so the belts feeding it still do.
- **An empty tile:** a straight belt is placed in a free segment slot, heading the way a dead end next to it points (else east), with that belt's speed and path, and every dead end pointing into the tile is linked to it.
- The splitter's input, and the tiles holding two segments (the splitter's output and the merge), are refused; the overlay says why.

The edit changes only the segments it names. `GpuBeltSim.updateSegments` writes those 32-byte records into the segment storage buffer with `queue.writeBuffer` and raises the belt instance count for a placed one. The segment buffer is allocated with 256 free slots from the start, so no buffer or bind group is recreated. Queue writes are ordered with the step submissions, so the edit takes effect between two ticks: the tick, the item buffers and the counters carry on, nothing is restarted or uploaded again.

**Dead ends.** Items don't block each other, so an item reaching the end of a belt that leads nowhere stays at progress `SEGMENT_LENGTH - 1` until the belt is relinked; then the queue moves on. The step shader and `referenceStep` do the same, and the built network has no dead ends, so its results are unchanged. The overlay's last line shows the last edit.

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
4. **Overlay.** Item count, adapter name, tick, and the simulation time per step. About twice a second one step submission is timed: with GPU timestamp queries around the step passes when the device has the `timestamp-query` feature, else with the wall clock from submission to `onSubmittedWorkDone`. The overlay says which (`GPU timestamps` or `wall clock`) and over how many ticks. The wall-clock figure includes the submission and the wait, so it is an upper bound.

**Determinism.** All state is integer, and every speed is below one tile, so an item crosses at most one boundary per tick. Items don't interact (there's no belt compression or blocking), so each item depends only on its own state, and any execution order gives the same result. `sim.ts` implements the same step in TypeScript (`referenceStep`, with `Math.imul` for WGSL's wrapping `u32` multiply), and the tests compare the two bit for bit.

**Render.** The item draw is instanced, and each instance draws `QUADS` items' quads as a triangle list: item `instance * QUADS + vertex / 6`. `?quads=1` is the textbook one quad per instance. Batching 64 per instance gives the same picture (a test checks this) and avoids a per-instance cost: SwiftShader runs an instanced draw as a loop over instances, which made one quad per instance about ten times slower there.

## Capture and benchmark

The demo can be recorded on a machine without a GPU, frame by frame, with the same frames on every run.

- `node tools/gpu-demo/capture.mjs` opens `?capture=1&timing=0` in headless Chromium (WebGPU on SwiftShader) and, for every frame, calls `window.__step(k)` and takes a 1280x720 screenshot. Frames go to `out/gpu-demo/frames/frame-00000.png` onwards. Frame 0 is tick 0, and each later frame is `--steps` ticks on (default 2, so 30 fps plays at the game's 60 ticks/s). It also writes `out/gpu-demo/capture.json` with the adapter, each frame's tick and step time, and the SHA-256 of the first and last frames. Flags: `--n` (items, default 1 000 000), `--frames` (default 60), `--steps`, `--timing` (show the measured step time in the overlay, which makes frames differ between runs), `--url` (a running server; without it the script starts a Vite dev server), `--out`, `--timeout`.
- `node tools/gpu-demo/assemble.mjs [--fps 30]` turns the frames into `out/gpu-demo/gpu-demo.mp4` (H.264 with libx264, else MPEG-4 part 2, yuv420p). It takes the first ffmpeg that can read PNG and write mp4, looking in `FFMPEG`, then `PATH`, then Playwright's download under `~/.cache/ms-playwright/ffmpeg-*`. Playwright's build only writes VP8 WebM for its video recording, so it is usually found and skipped, and the script says what each candidate lacks.
- `node tools/gpu-demo/bench.mjs` prints ms per step for 10k, 100k and 1M items, and the adapter it ran on. For each size it waits for the GPU to go idle, then times `--steps` ticks (default 16) without drawing, `--rounds` times (default 3), and reports the median and the best. Flags: `--sizes 10000,100000,1000000`, `--steps`, `--rounds`, `--warmup`, `--url`, `--timeout`.

`GPU_CHROME` points the scripts at another Chromium binary or a wrapper script, as for `npm run test:gpu`. They pass the same Chromium flags as `playwright.gpu.config.ts`.

**Why the frames are identical.** The item state is integer and each step is exact (see "Determinism"). In capture mode nothing runs on a timer: the page steps only when `__step` asks, and draws once per call. The overlay shows the tick, the ticks in this frame and the counters read back for this tick, all deterministic. The one value that varies between runs, the measured step time, is left out by `timing=0`. The script waits two animation frames after `__step` resolves so the compositor shows the new frame before the screenshot.

On SwiftShader, one million items take a few seconds per captured frame, so 60 frames take a few minutes.

`--resume` keeps the frames already in the output folder and captures only the missing ones, so a capture cut off by a restart or a crash carries on. For a missing frame after skipped ones it steps straight to the frame before it with one `__step` call, then takes the frame with the usual `--steps`, so the picture (including the overlay's "ticks for this frame") is the same as frame by frame. `settings.json` in the output folder stops frames of different flags from being mixed, and `log.jsonl` gets a line per frame as it is written. Frames are written under a temporary name and renamed, so a cut-off run leaves no half-written frame. `--film` adds `camera=film` with `filmticks` set so the film ends on the last frame.

## The film

`node tools/gpu-demo/film.mjs` records the demo film with one million items: `capture.mjs --film --resume`, retried (each retry resuming) if the browser or the GPU device fails, then `assemble.mjs --crf 26`. It writes `out/gpu-demo/film/frames/` and `out/gpu-demo/film/gpu-demo-film.mp4`. Stop it and start it again at any time. Flags: `--seconds` (24), `--fps` (15), `--steps` (ticks per frame, 4), `--n`, `--crf`, `--out`, `--retries`, `--fresh`, `--assemble-only`.

**Budget.** On SwiftShader, one 1M frame (4 ticks at about 100 ms each on the GPU timeline, the draw and the screenshot) took about 5 seconds of wall time on a 4-core machine at load average 40. A 30 fps film would be 720 frames for 24 s; 15 fps with 4 ticks per frame keeps the game's speed (60 ticks per second) with half the frames: 360 frames, 1436 ticks, at 1280x720. That run took 29 minutes. The item count stays at one million.

[`docs/screenshots/gpu-demo-film.mp4`](../../docs/screenshots/gpu-demo-film.mp4) is the result: 24.0 s, 360 frames at 15 fps, 1280x720, H.264 (crf 26), 3.7 MiB. Stills: [wide](../../docs/screenshots/gpu-film-wide.png), [the splitter](../../docs/screenshots/gpu-film-splitter.png), [a rotated belt backing items up](../../docs/screenshots/gpu-film-dead-end.png), [the end card](../../docs/screenshots/gpu-film-end-card.png).

**Script** (`filmShot` in `camera.ts`, a pure function of the tick and the film's length, so a resumed capture draws the same frames):

| Part of the film | What it shows |
|---|---|
| 0 to 14 % | The whole factory, with the item count as a caption |
| 14 to 34 % | Zoom into the splitter (6x). The zoom is on a log scale and the center moves with the view's width, so the splitter stays in view |
| 34 to 60 % | Close on the splitter and its outputs. Three scripted clicks (`filmEdits`) rotate the belt after the splitter's output: a right turn into nothing (items back up at the dead end, the belt turns red), a left turn, then straight again (the queue flows on). A ring marks the clicked tile |
| 60 to 78 % | Back out |
| 78 to 87 % | The whole factory again |
| 87 to 100 % | The end card: item count, how it works, the adapter, and, for a software adapter, that it is SwiftShader running WebGPU on the CPU, not a GPU, and that the film was captured frame by frame |

The overlay stays visible (above the end card) all the way, with the item count, the adapter (marked `software: WebGPU on the CPU, not a GPU` when the adapter is SwiftShader or says it is a fallback adapter), the tick, the zoom and the last edit. The step time stays hidden (`timing=0`), so no wall-clock value reaches a frame. The scripted clicks apply when the tick reaches theirs, however `__step` gets there: a call that crosses one steps up to it, edits, and steps on.

## Tests

- `tests/gpu/demoEdit.test.ts` (in `npm test`) checks the camera mappings (the fit camera draws as `fitView`, zoom keeps the point under the pointer), the film script (wide, into the splitter and out, smooth zoom, the splitter and the edited tile in view, the end card) and the click rule, with the reference step holding items at a dead end and draining them when it is relinked.
- `tests/gpu/demo.test.ts` (in `npm test`) checks the CPU side. The network is one connected loop with one splitter and one merge, every link enters the right neighbor tile, and the reference step advances, conserves and splits items deterministically. It also covers the limits and view helpers.
- `tests/gpu/gpuDemo.spec.ts` (`npm run test:gpu`, `playwright.gpu.config.ts`) runs headless Chromium with WebGPU on SwiftShader, against the production build under `/beltworks-play/`:
  - For 1, 255, 1000 and 4099 items, the GPU state after 1, 38, 102, 232 and 500 steps (in uneven batches across the 64-step submissions) equals `referenceRun` exactly, and the GPU counters equal `referenceCounters`.
  - One quad per instance and 64 per instance draw identical pictures.
  - At one million items, items cover the picture and move between two screenshots. The second screenshot goes to `test-results/`.
  - Capture mode: `__step` with 0, 7, 64, 1 and 100 ticks lands on exactly those ticks, the state equals `referenceRun`, every frame differs from the one before, and a second page draws byte-identical frames.
  - With timing on, the overlay shows the measured ms/step and which clock measured it.
  - Belt editing at 3000 items: real mouse clicks rotate a belt into a dead end, place a belt where it points and rotate it back. After each click the GPU's segment buffer equals the page's network, only the edited segments changed, and the tick and the full item state are exactly what they were before the click; the GPU state after further steps equals `referenceRun` on the edited network, items wait at the dead end and flow onto the placed belt. A drag pans and the wheel zooms without editing.
  - The film camera: stepping to a tick past two scripted clicks in 37-tick frames, or in one jump and the same last frame, gives the same item state, network, camera and screenshot bytes.
  - Without `navigator.gpu`, the page shows its message.

  `GPU_CHROME` points Playwright at another Chromium binary or a wrapper script. The config passes `--enable-unsafe-webgpu --use-angle=swiftshader --use-webgpu-adapter=swiftshader --no-sandbox --ignore-gpu-blocklist`, plus `--enable-features=Vulkan --use-vulkan=swiftshader`. With only the first set, SwiftShader's WebGPU can compute, but presenting a canvas loses the device. It isn't part of CI. On SwiftShader, one million items draw at about 1.5 to 2 frames per second, which the test allows for. Correctness is the point there, not speed.
