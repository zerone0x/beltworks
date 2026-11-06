# Roadmap

Every milestone ends the same way: all tests pass, benchmarks don't regress, a playable build is deployed, and Playwright screenshots are saved.

## M0 — Skeleton and prototype

- Vite + TS strict + Vitest + Playwright + ESLint/Prettier
- Worker message protocol, fixed-step tick loop, Command queue
- Seeded PRNG, chunked map generation (terrain + 4 resources)
- PixiJS: camera pan and zoom, terrain rendered per chunk
- Player movement, hand-mining, inventory (data + simple UI)
- Determinism hash test (Node + Chromium)
- CI (GitHub Actions) + deploy to GitHub Pages

**Done when:** you can walk around, zoom the map, and mine ore into your inventory in the browser, and the determinism test passes in CI.

## M1 — Core automation loop

- Place, remove, and rotate, with a ghost preview and collision checks
- Burner mining drill, stone furnace, wooden chest
- Transport belts (transport-line implementation) with 2 lanes
- Burner inserter (pickup and drop timing)
- Fuel (coal)
- Hand-crafting queue
- Benchmark scaffold (1k-entity scene first)

**Done when:** iron ore → drill → belt → inserter → furnace → inserter → chest produces iron plates with no player input, and the belt throughput test matches the design numbers exactly.

## M2 — Production chains and research

- Assembler (with a recipe picker) and lab
- Item and recipe tables (~30 items) with a craftability test
- Tech tree UI and research progress
- Red and green science
- Underground belts, splitters, belt tiers
- Iron chest and the other inserter types

**Done when:** you can go from nothing to automated red and green science and finish researching it.

## M3 — Power

- Boiler + steam engine + poles, with union-find power networks
- Electric mining drill, electric inserter
- Machines slow down in proportion to missing power; power panel with a supply/demand graph

**Done when:** machines visibly slow down when power runs short and recover once more generators are added.

## M4 — Performance

- Complete the machine sleep/wake system
- Benchmarks for 1k / 10k / 50k entities, reported in CI
- Viewport culling, sprite pools, faster rendering of belt items
- Faster snapshot transfer
- Evaluate moving hot paths to Rust→WASM

**Done when:** 10k entities and 50k items on belts hold a steady 60 UPS / 60 FPS.

## M5 — Polish

- Save and load (IndexedDB), autosave, save-version migrations
- Blueprints: box-select copy, paste, string import and export
- Minimap and map mode
- Sound effects and music (CC0 or original)
- Onboarding for the first 5 minutes
- Settings: keybindings, graphics, UI scale

**Done when:** v1 is ready for a public beta.

## Later (v1.x / v2)

- Fluids: crude oil, refining, pipes
- Blue science and beyond, the rocket
- Enemies, turrets, pollution
- Trains
- Multiplayer (deterministic lockstep with a WebSocket relay)
