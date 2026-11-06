# Architecture

## Overview

```
┌──────────────── Main thread ───────────────┐      ┌────────── Sim Worker ──────────┐
│ Input ──► Command queue ──postMessage──────┼─────►│ fixed step, 60 ticks/s          │
│                                            │      │ World (TypedArray / SoA)        │
│ Renderer (PixiJS v8) ◄── Snapshot ◄────────┼──────│ emits a render snapshot per tick│
│ UI panels (DOM)                            │      │ save serialization              │
└────────────────────────────────────────────┘      └─────────────────────────────────┘
```

- **Simulation and rendering are fully separate.** The simulation knows nothing about pixels, and the renderer never changes state.
- Every player action becomes a **Command** (`Place`, `Remove`, `Rotate`, `SetRecipe`, `Craft`, `Move`, …) tagged with the tick it applies on. This is what makes determinism, replays, and future multiplayer possible.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Fast iteration; hot paths can move to Rust→WASM later |
| Build | Vite | Fast, supports Workers natively |
| Rendering | PixiJS v8 | Best 2D sprite batching, WebGPU and WebGL backends |
| UI | Plain DOM, or Preact if it grows | Panels, inventory, and tech tree are DOM |
| Tests | Vitest (unit and determinism) + Playwright (E2E and screenshots) | |
| Saves | IndexedDB + binary format | |
| Hosting | GitHub Pages on a public deploy repo | Static site; see README |

## Simulation core

### Time
- A fixed 60 ticks/s, independent of frame rate. The Worker drives ticks from an accumulator; if it falls behind it catches up at most N ticks and drops the rest (single-player only).
- All speeds and progress are **integers** (for example, progress in units of 1/65536 and belt positions in units of 1/256 tile). **No floating-point value may end up in simulation state.** This keeps runs identical across browsers.
- Randomness comes from a seeded PRNG (xoshiro128**) that is only used inside the simulation.

### World and chunks
- The map is stored in 32×32 chunks: terrain tiles (`Uint8Array`) and resource amounts (`Uint32Array`).
- Chunks are generated lazily from noise whose output is integerized.
- Spatial index: a list of entity ids per chunk, plus a per-tile occupancy table for placement collision.

### Entity storage
- Data-oriented: one struct-of-arrays table per entity type, with an `id → index` sparse set.
- Example: `Assembler { recipe: Uint16, progress: Int32, inputs: Uint16[k], output: Uint16, energy: Int32, state: Uint8 }`.
- No generic ECS library. Like Factorio, each system is specialized and its hot loop only walks compact arrays.

### Update order (per tick)
1. Apply this tick's Commands
2. Power: compute the supply/demand ratio of each network
3. Mining drills
4. Belts (transport lines)
5. Inserters
6. Furnaces, assemblers, labs
7. Players: movement, hand-mining, hand-crafting
8. Emit the render snapshot and events

The order is fixed and covered by tests.

### Belts: transport lines
This is Factorio's core optimization, and it has to be there from day one:

- Connected belts facing the same way merge into one **transport line**. Each line has 2 lanes that move independently.
- A lane stores the **gaps between items**, not each item's absolute position.
- Each tick only the first movable gap shrinks, so moving a whole lane costs O(1).
- Inserting or removing items (inserters, side-loading) updates the lane locally.
- Placing or removing a belt rebuilds only the affected lines (merge or split).
- A full lane that can't move goes to sleep.

### Machine sleep
- Entity state: `Working | NoInput | OutputFull | NoPower | Idle`.
- An entity that isn't Working leaves the active list and waits on the event that would wake it (a chest gets a new item, an output slot is emptied, and so on). Once woken, it rejoins the active list.
- An inserter waiting to pick up only wakes when the items at its source change.

### Power
- Poles are kept in connected networks with union-find, updated incrementally on placement (rebuilt locally on removal).
- Each tick, for each network: `satisfaction = min(1, supply / demand)` as an integer ratio, and machines slow down in proportion.
- Generators produce only what is demanded and burn fuel in proportion.

### Prototypes and data
- Every prototype (item, entity, recipe, technology) is defined in `src/data/*.ts` and compiled at startup into numeric-id tables.
- The data is validated, and a test checks that every item can be crafted from raw resources.

## Rendering

- Only chunks in the viewport, plus a one-chunk margin, are rendered.
- Terrain: each chunk is baked into one RenderTexture and re-baked when it changes.
- Entities: separate Containers per layer (ground → items on belts → buildings → inserters → overlays), with pooled sprites.
- Items on belts: the main thread computes their positions from the lane data in the snapshot, interpolating between ticks so motion looks smooth.
- All textures are packed into atlases.
- Zooming out past a threshold switches to a "map mode" of flat colors.

### Worker protocol
- Messages are typed in `src/worker/protocol.ts`. Main → worker: `init {seed}`, `commands [...]`, `setViewport {x, y, w, h}` (tiles). Worker → main: `snapshot`, `stats {tick, tickMs, droppedTicks}`, `error`.
- The main thread sends commands without a tick; the worker stamps each one with the next tick it will run, so a command can never land on a tick that already ran.
- The worker loop (`src/worker/loop.ts`) accumulates wall time and runs whole 60 Hz ticks, at most 5 per wake-up; any further backlog is dropped.
- **One snapshot per wake-up, not per tick.** When the worker catches up several ticks at once, only the newest state is useful for rendering; the snapshot carries `ticksRun` so the renderer can tell. At full speed a wake-up runs one tick, so this is usually one snapshot per tick.
- `stats` go out every 30 ticks; the main thread derives UPS from them and shows it in the debug overlay.

### Snapshot transfer
- v1: after each wake-up that ran a tick, the Worker writes the state visible in the viewport into a transferable `ArrayBuffer` and sends it to the main thread.
- Later: a double-buffered SharedArrayBuffer. This needs COOP/COEP headers, which GitHub Pages can't set, so it would need a service-worker workaround or another host.

## Saves and blueprints

- A save holds the seed, every modified chunk, the entity tables, and global state, serialized to binary with a version number and migration functions.
- A blueprint is a list of entities in relative coordinates, turned into JSON, compressed, and base64-encoded into a copyable string.

## Determinism and testing

- **Determinism test:** the same seed and the same Command sequence, run for N ticks, must produce the same state hash. CI runs it in both Node and Chromium and compares the hashes.
  - The scenario lives in `src/sim/scenarios/determinism.ts`; the expected hash lives only in `tests/sim/determinism.expected.ts`, and both `tests/sim/determinism.test.ts` (Node) and `tests/e2e/determinism.spec.ts` (Chromium) compare against it.
  - Chromium reaches the scenario through `window.__beltworks` (`src/testHook.ts`), which exists only in dev builds and `vite build --mode test` (what Playwright serves). Production builds don't contain it.
  - The hash covers the tick counter, seed, PRNG state, every entity table, and the world (through its `hashInto` hook). Commands queued for future ticks are input, not state, and are not hashed.
- **System unit tests:** belt throughput (exact items per second for each tier), inserter swing timing, assembler output rate.
- **Replays:** Command logs are recorded and can be replayed to debug.
- **Benchmarks:** fixed scenes (1k / 10k / 50k entities) measure mean and P99 tick time, and CI reports regressions.

## Multiplayer (v2+, reserved)

- Deterministic lockstep: the server only relays Commands, every client simulates on its own, and state hashes are compared regularly to catch desyncs.
- Already in place: Commands carry a player id and a tick, and the simulation has no local clock and no floating-point state.

## Performance targets

| Scene | Target tick time (16.6 ms budget) |
|---|---|
| 1k entities | < 1 ms |
| 10k entities + 50k items on belts | < 8 ms |
| 50k entities | < 16 ms (if missed, evaluate moving to WASM) |

## Directory layout

```
src/
  sim/            # pure simulation: no DOM, runs in Node
    world/        # chunks, terrain generation, spatial index
    entities/     # SoA tables and systems for each entity type
    belts/        # transport lines
    power/
    scenarios/    # scripted runs shared by tests (determinism)
    commands.ts   # Command union, validation, ordered queue
    state.ts      # SimState, world slot, state hash
    tick.ts       # Sim: enqueue/step/hash, fixed system order
    fixed.ts      # fixed-point helpers (1/256 tile, 1/65536 progress)
    snapshot.ts   # render snapshot encoding
    hash.ts
    rng.ts
  data/           # prototypes (items, recipes, technologies)
  worker/         # Worker entry point and message protocol
  render/         # PixiJS rendering
  ui/             # DOM panels
  main.ts
assets/           # source art
tools/            # atlas packing, benchmark scripts
tests/
  sim/            # Vitest
  e2e/            # Playwright
```
