# Roadmap

Every milestone ends the same way: all tests pass, benchmarks don't regress, a playable build is deployed, and Playwright screenshots are saved.

## M0 — Skeleton and prototype (done)

- [x] Vite + TS strict + Vitest + Playwright + ESLint/Prettier
- [x] Worker message protocol, fixed-step tick loop, Command queue
- [x] Seeded PRNG, chunked map generation (terrain + 4 resources)
- [x] PixiJS: camera pan and zoom, terrain rendered per chunk
- [x] Player movement, hand-mining, inventory (data + simple UI)
- [x] Determinism hash test (Node + Chromium)
- [x] CI (GitHub Actions) + deploy to GitHub Pages

**Done when:** you can walk around, zoom the map, and mine ore into your inventory in the browser, and the determinism test passes in CI.

Met: `tests/e2e/player.spec.ts` and `render.spec.ts` (walking, zooming, hand-mining), `determinism.spec.ts` (Node == Chromium).

## M1 — Core automation loop (done)

- [x] Place, remove, and rotate, with a ghost preview and collision checks
- [x] Burner mining drill, stone furnace, wooden chest
- [x] Transport belts (transport-line implementation) with 2 lanes
- [x] Burner inserter (pickup and drop timing)
- [x] Fuel (coal)
- [x] Hand-crafting queue
- [x] Benchmark scaffold (1k-entity scene first)

**Done when:** iron ore → drill → belt → inserter → furnace → inserter → chest produces iron plates with no player input, and the belt throughput test matches the design numbers exactly.

Met: `tests/e2e/chain.spec.ts` builds that chain from a new game with real input, fuels it through the entity windows, and waits for plates in the chest ([screenshot](screenshots/m1-chain.png)); the determinism scenario runs the same chain on stone (bricks) in Node and Chromium; `tests/sim/belts.test.ts` measures exactly 7.5 items/s per lane and 15 per belt, also end to end with drills saturating a belt. Deviations from the plan are recorded in [DECISIONS.md](DECISIONS.md) (D10–D17).

## M2 — Power (done)

- [x] Small electric poles with union-find power networks and the power solver (satisfaction per network, producers deliver what is drawn)
- [x] Power items and recipes; trees and wood
- [x] Boiler + steam engine
- [x] Electric mining drill, electric inserter
- [x] Machines slow down in proportion to missing power; power panel with a supply/demand graph
- [x] Benchmark scene with power (`power`: boilers, engines, poles, electric drills and inserters, two networks overloaded)

**Done when:** machines visibly slow down when power runs short and recover once more generators are added.

Met: `tests/e2e/overload.spec.ts` builds a boiler, a steam engine, poles and eight electric drills into chests with real input and measures their rate from the ore reaching a chest (one unit per drill every 2 s); with eight more drills the network is overloaded (62% satisfied, every drill shows the yellow low-power bolt) and the rate drops to about 0.62 of that; a second boiler and engine bring it back to full speed. The power panel shows each step and the last minute as a graph ([screenshot](screenshots/m2-power.png)). `tests/sim/electric.test.ts` checks the exact rates at satisfaction 1, 1/2 and 0, and the determinism scenario (Node == Chromium) covers poles, steam power and electric machines. Deviations from the plan are recorded in [DECISIONS.md](DECISIONS.md) (D18–D31).

Power comes before production chains because assemblers and labs are electric ([DECISIONS.md](DECISIONS.md), D20).

## M3 — Production chains and research (done)

- [x] Assembler (with a recipe picker) and lab
- [x] Item and recipe tables (~30 items) with a craftability test
- [x] Tech tree UI and research progress
- [x] Red and green science (science packs, technologies, labs)
- [x] Belt tiers (fast, express) and underground belts
- [x] Splitters
- [x] Iron chest and the other inserter types (fast, long-handed; the electric inserter comes with M2)
- [x] Benchmark scene with production and research (`m3`: assembling machines, labs, splitters, undergrounds and all four inserter types)

**Done when:** you can go from nothing to automated red and green science and finish researching it.

Met: `tests/e2e/science.spec.ts` starts from a test kit (assembling machines, a lab, electric inserters, belts, chests, poles, a boiler and steam engine, coal and plates) with automation, electronics and logistic science pack already researched (D45), and builds with real input next to the spawn a red science line (iron plates from a chest → inserter → assembling machine making gears → inserter → assembling machine making automation science packs, with copper plates from a second chest → inserter → lab) and a green one (electric inserters and transport belts from two chests → inserters → assembling machine making logistic science packs → inserter → belt → inserter → the same lab), all on a boiler and steam engine. Once the last chest is filled the player stands still, and automation 2 (40 units of red + green) is researched with no further input, which unlocks the assembling machine 2 ([screenshot](screenshots/m3-science.png)). What the kit skips is checked in Node: `tests/sim/research.test.ts` checks that every technology can be researched from a new game, in an order that only uses recipes unlocked so far, and `tests/sim/recipes.test.ts` that every item can be made from raw resources. The `m3` benchmark scene runs 40 such science cells (1 170 entities) at well under 1 ms a tick. Deviations from the plan are recorded in [DECISIONS.md](DECISIONS.md) (D32–D45).

## M4 — Performance (done)

- [x] Complete the machine sleep/wake system: incremental power solve, logarithmic lane queries, active-entity counters in the bench and debug overlay (#73, D62)
- [x] Benchmarks for 1k / 10k / 50k entities, reported in CI (the quick scenes on every PR, 10k and 50k nightly and on demand; #72, #80)
- [x] Viewport culling, sprite pools, faster rendering of belt items, terrain bakes spread over frames, a scripted render profile (#74)
- [x] Faster snapshot transfer: delta snapshots, encoders that allocate about 100 B per call (the view they return), compact belt items; no SharedArrayBuffer (#75, D56)
- [x] Evaluate moving hot paths to Rust→WASM: not needed now, with the numbers and what would reopen it (#76, D68)

**Done when:** 10k entities and 50k items on belts hold a steady 60 UPS / 60 FPS.

Met for the simulation (60 UPS), measured by the documented method; 60 FPS on a real GPU is for the owner to confirm. **Ticks** (`npm run bench`, CI `workflow_dispatch` on #76's branch, Node 22 on a 4-CPU `ubuntu-latest` runner): `1k` 0.0125 ms a tick (target 1 ms), `10k` with 52 500 items on belts 0.27 ms (p99 0.38 ms; target 8 ms), `50k` with 268 000 items on belts 1.75 ms (p99 2.25 ms; target 16 ms), every state hash identical to the baselines (whose runner, another CPU model, measured 0.40 and 2.55 ms for the same code); a 50k tick uses about a tenth of a 60 UPS budget. **Frames** (`npm run profile:render`, docs/TOOLING.md "Render profile", on `npm run build:test`: the minified production bundle with the dev and test hooks that `?scene=` needs, which the deploy build compiles out): the 10k scene (10 037 entities, 49 000 items on belts in view at 0.25×) in headless Chromium on SwiftShader, 1280×720, on a shared and heavily loaded 4-core container. There the main thread's JavaScript per frame (`work`, p50 / p99) is 15 / 28 ms at 2×, 12 / 31 ms at 1×, 33 / 68 ms at 0.5×, 44 / 112 ms at 0.25× with everything in view, 1 / 14 ms in map mode and 19 / 125 ms panning at 1×, while the frame interval (0.3–1.5 s) is the software rasterizer's fill rate and says nothing about a GPU; the worker kept 53–76 UPS with catch-ups (the machine's load around 20). Frame times on a real GPU are pending: run `PROFILE_GPU=1 npm run profile:render` on a desktop, or open `?scene=10k&profile=1` on `npm run dev`; the target is a p99 interval under ~20 ms on every factory stage. The open question of moving hot paths to Rust→WASM (Q3) is settled: not now (D68).

## M5 — Polish (done)

- [x] Save and load (IndexedDB), autosave, save-version migrations
- [x] Blueprints: box-select copy, paste, string import and export, a library (D59)
- [x] Minimap and map mode (#87)
- [x] Sound effects and music (original, synthesized in code; D55)
- [x] Onboarding for the first 5 minutes: title screen (seed, continue, load, settings), objectives, tooltips
- [x] Settings: keybindings, graphics, UI scale; hotbar management and the cursor stack
- [x] Public beta readiness: the version in the UI, About (controls, credits, licenses), a player-facing README and a changelog, messages for unsupported browsers and simulation crashes (with the newest save to load), the debug info behind F3, and a release check of the production build (#92, D61)

**Done when:** v1 is ready for a public beta.

Met: `npm run test:release` plays the production build as it deploys (base path `/beltworks-play/`, no test hook) with real input only: from the title screen a new game follows the objectives by their directions to the stone patch, mines stone and crafts a furnace, saves from the game menu and continues after a reload; then the `m3` factory (1 170 entities, labs on red and green science) imported as a save file researches logistics 2 with no input ([screenshot](screenshots/m5-release-science.png)). From nothing to automated green science is covered end to end by `tests/e2e/science.spec.ts` and `onboarding.spec.ts` on the test build and in Node by `tests/sim/research.test.ts`; the live site loads to the title screen and into a new game at 60 UPS without errors. `tests/e2e/release.spec.ts` checks the crash message (it loads the newest save, [screenshot](screenshots/m5-crash.png)), the unsupported-browser message ([screenshot](screenshots/m5-unsupported.png)), and the version and About on the title screen and in the menu ([screenshot](screenshots/m5-about.png)). The simulation is as fast as at the M4 baseline: on one machine, back to back, the baseline commit and this build run the 10k scene at 0.44–0.49 ms and 0.47 ms a tick (the 50k scene at 7.7 and 8.0 ms on a busy machine; 3.0 ms on CI). The owner kept the name Beltworks (Q5, D61), and the game is MIT-licensed (#110). Deviations and additions are recorded in [DECISIONS.md](DECISIONS.md) (D46–D61). M4's open items (the complete sleep/wake system, CI-reported benchmarks for every size, the WASM evaluation) remain open and don't block the beta.

## Later (v1.x / v2)

- Fluids: crude oil, refining, pipes
- Blue science and beyond, the rocket
- Enemies, turrets, pollution
- Trains
- Multiplayer (deterministic lockstep with a WebSocket relay)
