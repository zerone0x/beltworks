# Changelog

What changed in Beltworks, newest first. Milestones M0–M4 were development builds without version numbers; the first versioned release is the v1 public beta. Numbers in parentheses are pull requests or issues on GitHub. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [semantic versioning](https://semver.org/) from v1 on: a save made by one version loads in every later one (saves are migrated, D46).

## Unreleased

### Added

- **Demo factory** (#142, D72): a "Demo factory" button on the title screen and a `?demo` link start a game in a complete factory, from ore to research (drills, furnaces, a plate bus, assembling machines, red and green science, labs researching one technology after another for about an hour, steam power on mined coal), built through commands by a scripted player; the camera frames it and the objectives stay off. `npm run capture:promo` records frame-stepped footage of it (shots per stage, a highlight reel, stills, production counts) for promo videos and the README clip.

### Changed

- Idle machines cost (almost) nothing per tick: an incremental power solve, logarithmic belt lane queries and per-system activity counters in the benchmarks and the debug overlay (#73, D62).
- The title screen shows without waiting for the renderer (#112, D64): PixiJS loads in the background while it is up, in a chunk of its own that stays cached across releases; the first download before the title screen drops from about 170 kB to 64 kB (gzipped). If the game's files can't be downloaded (offline), a message says so and offers Reload.

- The player is magenta instead of orange, which vanished on copper ore, and the pickaxe is easier to see (#128, D70).
- Sprite atlases are smaller: the packer drops the noise of the shadow frames (the player's sheet is 48% smaller in texels and its PNG 14%, the other atlases' PNGs 8 to 19%) (#128, D70).

### Fixed

- The player stands in the buildings' depth order: one north of a building is behind it instead of drawn over it (#128, D70).
- An inserter dropping onto a belt loop made of a single line keeps the item spacing across the loop's seam (#73).
- A splitter whose output is in front of a sparse input's half carries all it can when a full input's items cross over into that half, instead of up to a quarter less (#78, D71). Sparse inputs that arrive in clumps still lose some throughput.
- Saved key bindings survive an update that adds several actions at once, or whose new action's default key chains through other rebound keys, instead of resetting to the defaults (#125, D53).

## 1.0.0-beta.1 — M5, polish: public beta

### Added

- **Public beta readiness** (#92): the version in the title screen, the game menu and About; an **About** panel (controls as bound, credits, licenses) on the title screen and in the game menu; `third-party-licenses.txt` with the bundled packages' licenses, written by every build; a message instead of a broken page on browsers without what the game needs (module workers, WebGL, compression streams, Web Crypto), and a note when saves are off (no IndexedDB); when the simulation crashes, a message that offers to load the newest save; **F3** (or the settings) toggles the debug info, now hidden by default; a player-facing README and this changelog; a release check that plays the production build with real input (`npm run test:release`); the game's own license, MIT (#110).
- **Blueprints** (#108): box-select copy, paste with ghosts and rotation, `BW1.` string export and import, a blueprint library in the browser.
- **Snapshot transfer** (#103): delta snapshots, allocation-free encoders and compact belt items (D56).
- **Title screen and onboarding** (#104): Continue, New game on a world seed, Load, Settings; eight "Getting started" objectives for the first five minutes; rich tooltips for items, recipes and entities.
- **Sound and music** (#100): effects and generative music synthesized in the browser with WebAudio, no samples (D55).
- **Minimap and map mode** (#102): a minimap of what you have explored, and a flat-colour map view when zoomed far out (D53).
- **Settings** (#98): rebindable keys, graphics options, UI scale, volumes; hotbar pins and the cursor stack (D50–D52).
- **Save and load** (#96): saves in IndexedDB, autosave every 5 minutes of play in three rotating slots, export and import of `.bwsave` files, save-format migrations and a round-trip guarantee (D46).

### Changed

- The game pauses while the game menu is open (#105, D57); autosaves count play time, not wall time, and the objectives' progress is kept per save (#109, D60); the assembler's recipe picker uses the rich tooltips (#109).
- A manual save restarts the autosave count, so an autosave never follows right after it (#92).

### Fixed

- Inserters pick up only ingredients the target machine can use now (#95) and drop into any free gap on their belt tile (#101).
- A splitter merging a sparse input into a busy one no longer sends out empty slots: the busy side makes way for each item as it comes (#106, D58).
- A damaged save file says so clearly when imported (#105).
- Importing a blueprint string no longer leaves a storage error unhandled (#92).

## M4 — performance (in progress)

- Viewport culling, sprite pools, batched belt items, terrain bakes spread over frames and a scripted render profile (#93).
- 10k and 50k entity benchmark scenes with per-system timings (#80); faster snapshot transfer (#103, listed above).
- Still open: the complete machine sleep/wake system, benchmarks reported in CI for every size, and the Rust→WASM evaluation (Q3).

## M3 — production chains and research

- Assembling machines with a recipe picker (#53); fast and long-handed inserters and the iron chest (#52).
- Belt tiers (fast, express) and underground belts (#54); splitters (#68).
- Science packs, technologies, labs and the tech tree (#64); automated red and green science end to end (#84).
- The Blender sprite pipeline (#58) and rendered sprites for every entity, the terrain, trees and item icons (#61, #62, #63, #67, #71).
- Fixes: belt item spacing across line boundaries after rebuilds (#65), the exact asleep-but-could-move belt check (#94).

## M2 — power

- Power items and recipes, trees and wood (#37).
- Small electric poles, networks and the power solver (#39); boiler and steam engine (#40); electric mining drill and electric inserter (#41).
- The power panel with a one-minute graph, and the `power` benchmark scene (#44).
- Stack splitting, readable item icons and a clickable hotbar (#38); selecting any inventory item for building, and the pipette (#43).

## M1 — the core automation loop

- The entity framework: placement, removal, rotation and the ghost preview (#22).
- Burner fuel, the stone furnace, the wooden chest and entity windows (#24); recipes and the hand-crafting queue (#23).
- The burner mining drill (#25), transport belts with two lanes (#27) and the burner inserter with sleep/wake (#29).
- The headless benchmark runner and its CI report (#28); the automation chain end to end (#35).

## M0 — skeleton and prototype

- Project scaffold: Vite, strict TypeScript, Vitest, Playwright, ESLint and Prettier, CI and the deploy to GitHub Pages (#6).
- Chunked deterministic world generation (#7); the fixed-step tick loop, command queue, worker protocol and the determinism test (#8).
- The camera and per-chunk terrain rendering (#9); player movement, hand mining, inventory and hotbar (#10).
