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

Met: `tests/e2e/science.spec.ts` builds, from a new game and with real input next to the spawn, a red science line (iron plates from a chest → inserter → assembling machine making gears → inserter → assembling machine making automation science packs, with copper plates from a second chest → inserter → lab) and a green one (electric inserters and transport belts from one chest → inserter → assembling machine making logistic science packs → inserter → belt → inserter → the same lab), all on a boiler and steam engine. Once the last chest is filled the player stands still, and automation 2 (40 units of red + green) is researched with no further input, which unlocks the assembling machine 2 ([screenshot](screenshots/m3-science.png)). The test starts from a test kit with the technologies before automation 2 researched (D46); `tests/sim/research.test.ts` checks that every technology can be researched from a new game, in an order that only uses recipes unlocked so far, and `tests/sim/recipes.test.ts` that every item can be made from raw resources. The `m3` benchmark scene runs 40 such science cells (1 170 entities) at well under 1 ms a tick. Deviations from the plan are recorded in [DECISIONS.md](DECISIONS.md) (D32–D46).

## M4 — Performance

- [ ] Complete the machine sleep/wake system
- [ ] Benchmarks for 1k / 10k / 50k entities, reported in CI
- [ ] Viewport culling, sprite pools, faster rendering of belt items
- [ ] Faster snapshot transfer
- [ ] Evaluate moving hot paths to Rust→WASM

**Done when:** 10k entities and 50k items on belts hold a steady 60 UPS / 60 FPS.

## M5 — Polish

- [ ] Save and load (IndexedDB), autosave, save-version migrations
- [ ] Blueprints: box-select copy, paste, string import and export
- [ ] Minimap and map mode
- [ ] Sound effects and music (CC0 or original)
- [ ] Onboarding for the first 5 minutes
- [ ] Settings: keybindings, graphics, UI scale

**Done when:** v1 is ready for a public beta.

## Later (v1.x / v2)

- Fluids: crude oil, refining, pipes
- Blue science and beyond, the rocket
- Enemies, turrets, pollution
- Trains
- Multiplayer (deterministic lockstep with a WebSocket relay)
