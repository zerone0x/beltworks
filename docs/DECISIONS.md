# Decision log

## Decided

| # | Decision | Why |
|---|---|---|
| D1 | Top-down 2D on a grid | Least work, and the gameplay doesn't need 3D |
| D2 | PixiJS v8 rather than Phaser | Only a renderer is needed; physics and scene management would go unused, and PixiJS batches sprites more lightly and quickly |
| D3 | The simulation runs in a Web Worker | The main thread only renders and handles input, so the game doesn't stutter |
| D4 | Integer-only, deterministic simulation | Reliable saves, replay debugging, room for multiplayer |
| D5 | Belts are transport lines with gap arrays | The only approach proven to scale |
| D6 | TypeScript first, with data laid out as TypedArrays | Fast iteration, cheap to move to WASM if needed |
| D7 | v1 is single-player with no combat or fluids | Keeps the focus on the core loop |
| D8 | Original names and art | Avoids copyright problems |
| D9 | Private source repo, public deploy repo `beltworks-play` on GitHub Pages | GitHub Pages isn't available for private repos on the current plan |
| D10 | Entity windows move items with `Insert {entity, item, count}` and `Take {entity, slot, count}` commands, naming entities by id (ids are never reused), instead of Factorio's cursor stack | There is no cursor stack yet; two commands cover every M1 transfer, stay deterministic, and are checked for reach in the simulation. A cursor stack can come with the M5 UI work |
| D11 | In an entity window, a click on an inventory stack inserts all of it and a right click half of it (rounded up); there is no "insert one" yet | Enough to share the starting coal between the machines of the M1 chain (the E2E test does exactly that); finer splitting is a follow-up |
| D12 | The burner mining drill is rotatable: it drops onto the tile in front of the left half of its front edge, whichever way it faces | Drills have to feed belts, furnaces and chests on any side; the drop tile is the same relative to the drill in every direction |
| D13 | Drills (and a hand's `Insert`) put items on the middle of a belt through the generic item hook: right lane first, the left lane when the right has no room there. Inserters drop onto the far lane | One hook serves every producer, with no belt-specific code in the drill. Unlike Factorio, a drill does not pick its lane from its side of the belt, so a lightly fed belt carries mostly on its right lane; once the right lane backs up the left fills, and drills saturating a belt still deliver exactly 15 items/s (`tests/sim/belts.test.ts`). Revisit if lane-specific builds need it (splitters, M2) |
| D14 | Waiting entities sleep, subscribed to the one entity they wait on, and are woken by notifications; a belt line only notifies its watched belts near the stretch of a lane that changed | Drills blocked on a belt and inserters waiting for items cost nothing per tick, which the 10k/50k targets (M4) need. Belts nobody watches pay nothing for notifications |
| D15 | An inserter with an empty fuel slot takes one unit of fuel from its source for itself (the optional rule from #17) | An inserter next to coal starts on its own, without a GUI step |
| D16 | Benchmarks: each scene runs 3 untimed and 5 measured runs of 600 warm-up and 3 600 timed ticks, and the run with the median mean is reported; the baseline comes from the CI runner's artifact, and regressions over 20% only warn | A 1k-scene tick takes microseconds: V8 warm-up, GC pauses and the mixed CPU pool of `ubuntu-latest` swing single runs by tens of percent, so a blocking check would be noise (docs/TOOLING.md, "Benchmarks") |
| D17 | A new game starts with a kit of belts, inserters, drills, furnaces, chests and coal (`src/data/start.ts`) | Makes the M1 loop reachable without hand-crafting everything first; the crafting queue arrived in the same milestone |
| D18 | Trees are a per-chunk layer of the world (not entities): generated from forest noise on grass outside a 48-tile starting radius, felled whole by hand-mining for 4 wood, blocking placement but not walking | Thousands of trees per forest would bloat the entity tables and the occupancy index; as world data they cost one byte per tile, are hashed like resources (only modified chunks), and are drawn in the baked chunk texture. Walking through them keeps movement simple; revisit if forests should block the player |
| D19 | The M2 power entities exist as prototype stubs (placeable placeholders) before they get behavior, and copper cable (made in twos) is not auto-queued as an intermediate | The data issue lands in parallel with the electric-network, generator and consumer issues, which add the tables; the crafting planner only auto-queues recipes that make exactly one unit, so the queue can refund cancelled crafts without tracking leftovers |

## Open

| # | Question | Decide when |
|---|---|---|
| Q1 | UI: plain DOM or Preact | When the UI grows past the inventory (M2) |
| Q2 | Snapshot transfer: transferable buffers or SharedArrayBuffer (needs COOP/COEP) | After the M4 benchmarks |
| Q3 | Whether and when to move to Rust→WASM | M4 |
| Q4 | Final art style (pixel or flat vector) | Deferred from M1: placeholders until the M5 polish work |
| Q5 | Final name (working title: Beltworks) | Before the public beta |
