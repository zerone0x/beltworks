# Tooling and workflow

## References

| Project | What to use it for |
|---|---|
| [tobspr-games/shapez-community-edition](https://github.com/tobspr-games/shapez-community-edition) | An open-source browser factory game: reference for belts, building interactions, saves, and chunk rendering |
| [JackHopkins/factorio-learning-environment](https://github.com/JackHopkins/factorio-learning-environment) | Reference for modeling recipes and entities as data |
| Factorio Friday Facts (official blog) | Design details on belt optimization (FFF #176), inserters, and power |
| [Game Programming Patterns](https://gameprogrammingpatterns.com/) | Game loop, Command pattern, data locality |
| [awesome-learn-gamedev](https://github.com/dawdle-deer/awesome-learn-gamedev) | General learning resources |

> Borrow design ideas only, never code. shapez CE is licensed GPL-3.0.

## Art

- [Blender](https://www.blender.org/) 4.2 LTS, headless: entity sprites are procedural `bpy` models under `art/blender/`, rendered and packed into `public/sprites/` by `npm run art` (D34; style guide, pipeline and how to add a model in docs/ART.md). Point the `BLENDER` environment variable at your Blender binary or a wrapper script; on the dev machine the default is `~/tools/blender.sh`. CI doesn't run Blender: the atlases are committed.
- Entities without a model keep their placeholders drawn in code (colored shapes).

### Dev and test URL parameters

Dev and test builds (`npm run dev`, `npm run build:test`) read a few URL parameters (`src/testHook.ts`); production builds contain none of them.

| Parameter | Effect |
|---|---|
| `?kit=name:count,...` | The starting kit (D29) |
| `?art=1` / `?art=0` | The terrain's rendered look (D41) or the flat placeholder colors, until the terrain setting is changed in game (D50). Default: the terrain setting in dev builds (rendered unless changed), placeholder in test builds, so the end-to-end specs that aren't about the art stay fast on CI's software renderer, where baking the rendered terrain is slow. The art, render and screenshot specs (`art.spec.ts`, the `*Art.spec.ts` logistics sprite specs, `render.spec.ts`) pass `?art=1` |
| `?scene=name` | A render scene (`src/worker/renderScene.ts`), for the render profile: a benchmark scene (`1k`, `power`, `m3`, `10k`, `50k`; see "Benchmarks"), which the worker builds through commands at start in place of the new game (about 1.5 s for `10k`) and then simulates, or a grid factory (`grid-1k`, `grid-10k`) that is ready at once: no simulation behind it, the worker sends its entities, belts, inserters and grid in every snapshot instead of the simulation's (10 032 entities and 49 632 items on belts, every belt full and every machine working, for `grid-10k`). Neither changes anything for a game without the parameter. See "Render profile" |
| `?profile=1` | Runs the render profile once the art has loaded and shows the report in a panel (and the console); `profileMs=` sets the recorded time per stage, `profileStages=` (comma-separated names) picks stages |
| `?texels=8\|16\|32\|64` | The most texels per tile the rendered terrain bakes at (implies `?art=1`; 64 allows the detail textures zoomed in, as on a GPU); software renderers default to 16 (docs/ART.md, "Terrain") |

## Agent workflow

| Tool | Where it's used |
|---|---|
| orbit | Turns GitHub issues into PRs, with hunter agents writing code and verifier agents checking it |
| [pstack](https://github.com/backnotprop/pstack) `architect` + `arena` | Key architecture decisions (entity storage, snapshot protocol, WASM migration) |
| pstack `tdd` | Every simulation system starts with tests |
| pstack `statechart` | State machines for inserters and assemblers |
| pstack `benchmark-checklist` | Performance work in M4 |
| [gstack](https://github.com/garrytan/gstack) | Plan review, QA in the browser |

## Development rules

- `src/sim` must not import the DOM or PixiJS, must not call `Math.random` or `Date.now`, and must not store floating-point values in state. An ESLint rule enforces this.
- Every PR passes the unit tests and the determinism test. A PR that touches a simulation hot path includes benchmark results (see "Benchmarks" below; the bench workflow posts them on every PR).
- A PR that changes visuals includes Playwright screenshots.
- Commit messages and PR titles use conventional commits: `<type>(<scope>): <subject>`.

## End-to-end tests

The Playwright suite (`tests/e2e/`, `npm run test:e2e`) drives a test-mode build (`vite build --mode test`: the production build plus the `window.__beltworks` test hook) with real keyboard and mouse input. Locally, Playwright builds it and serves it with `vite preview` on port 4173, or on `E2E_PORT` when set (another checkout's preview server on 4173 would otherwise be reused); `npx playwright test --shard 2/6` runs one shard the way CI does.

**CI** (`.github/workflows/ci.yml`) splits the suite so it doesn't run in one long job:

| Job | What it does |
|---|---|
| `check` | Lint, typecheck, unit tests (including the Node half of the determinism check), benchmark tooling tests, production build |
| `e2e-build` | Builds the test bundle once (`npm run build:test`) and uploads `dist/` as the `e2e-dist` artifact |
| `e2e-shard (i/6)` | Six shards in parallel, each `npx playwright test --shard i/6` against the downloaded bundle (`E2E_PREBUILT=1` makes the config only serve `dist/`, not build it), one worker each, 15 min timeout; each uploads a blob report and its `test-results/` (screenshots, failure context) |
| `e2e` | Waits for the shards (`if: always()`), merges their blob reports into one HTML report (`npx playwright merge-reports`, the `playwright-report` artifact), and fails unless the build and every shard passed. This is the one status to require for the e2e suite |

Playwright shards by test count, in file order (`fullyParallel` makes every test its own unit), so each test runs in exactly one shard; in particular the Chromium half of the determinism check (`determinism.spec.ts`, Node == Chromium) runs once per CI run, and the Node half once in `check`. Every spec asks for what it needs in its own URL (`?kit=`, `?research=`, and `?art=1` / `?texels=` for the rendered terrain in the art and render specs; see "Dev and test URL parameters"), so a spec runs the same whichever shard it lands in. Shards are balanced by count, not time: each shard gets a run of consecutive tests (files in alphabetical order, tests in file order), so long tests next to each other in that order end up in the same shard. That is why the logistics sprite tests are one per file and named after their subject (`beltTiersArt.spec.ts`, `insertersArt.spec.ts`, `sceneArt.spec.ts`) rather than all in one file next to `art.spec.ts`: on CI, `overload.spec.ts` (over two minutes), `science.spec.ts`, `art.spec.ts` (over a minute each) and the sprite scene take the most time, and should stay apart. A new spec shifts every shard boundary after it, so check the per-shard times in the run summary (`npx playwright test --list --shard i/6` shows which tests a shard gets); keep the slowest shard around 5 minutes, by splitting a long spec into files that land in different shards or by adding a shard (a matrix entry and `total`).

**Keeping specs short.** CI's Chromium renders in software on 2 vCPUs, sometimes at 7 fps, so walking and clicking are slow and every second of simulated time is a second of wall time. When a spec waits on a long process while the player stands still (research, mining, measuring a production rate), run the simulation faster with `fastForward` / `setTimeScale` from `tests/e2e/timeScale.ts` (the test hook's `setTimeScale`, dev and test builds only; D42), and go back to normal speed before walking or building again: the player walks faster too. It changes only how many ticks run per second, so anything measured in ticks or game state stays exact; avoid it where a check polls for a short-lived state once per rendered frame. Build near the spawn with a `?kit=` (D29) or `?research=` (D38) start rather than walking or crafting there when the walk or the crafting isn't what the spec tests. Walk as little as possible, and only with `walkNear` from `tests/e2e/walk.ts`: at a low frame rate each rendered frame of walking covers more than a tile and key releases take effect late, so it measures the frame rate, scales its timeout with it, releases the keys a frame early and taps single frames close to the target; give it a tolerance of at least 1.5 tiles. Where a spec builds a lot in one place (`overload.spec.ts`), walk there once and lay the build out around where the player actually stopped, within build reach of all of it, rather than walking between build spots.

## Render profile

The render profile (`src/profile/renderProfile.ts`) measures frame times the way a player sees them. It drives the camera through fixed stages and records every frame of each: bare terrain at 1×, 0.5× and 0.25× (200 tiles south of the spawn), the `?scene=10k` benchmark factory (10 037 entities, about 50 000 items on belts; `PROFILE_SCENE` picks another) at 2×, 1×, 0.5× and 0.25× (0.25× shows nearly all of it), panning across the factory at 1× and 0.5× and across bare terrain at 1× (512 screen pixels per second, so new chunks keep coming into the bake margin), and a jump to unbaked terrain (recorded from the jump, so its frames include the bakes). Each stage waits until the terrain around the view is baked and the worker has sent the scene, renders 30 warm-up frames, then records for 3 s and at least 20 frames (software renderers can take hundreds of milliseconds per frame).

For each stage it reports:

- **interval**: the time from one frame to the next (p50 / p95 / p99 / max), and the mean frame rate. It includes whatever the GPU, or a software rasterizer, needs before the browser starts the next frame, so it is the frame time on screen; with vsync it can't go below ~16.7 ms.
- **work**: the main thread's time inside a frame (the game's ticker callbacks, then Pixi building and submitting the draw calls). It is the JavaScript cost of rendering even where vsync or a slow rasterizer hides it in `interval`.
- frames over 50 ms (hitches), terrain textures baked during the stage, and the entities, belts and belt items around the view at its end.

```sh
npm run profile:render                                 # headless Chromium (software rendering), 10k scene
PROFILE_MS=1000 PROFILE_STAGES="factory 1x,pan terrain 1x" npm run profile:render
PROFILE_GPU=1 npm run profile:render                   # headed Chromium on this machine's GPU
PROFILE_URL=http://localhost:5173/ npm run profile:render   # against `npm run dev` instead of a test build
```

It is a Playwright run of `tests/profile/render.profile.ts` (`playwright.profile.config.ts`: a test build served on port 4174, separate from the end-to-end suite). The report goes to stdout and to `profile-results/render.md` and `.json`. Other variables: `PROFILE_SCENE` (a `?scene=` name), `PROFILE_FRAMES` (minimum frames per stage), `PROFILE_TEXELS` (`?texels=`), `PROFILE_ART=0` (placeholder terrain), `PROFILE_OUT` (output path without extension).

**On a real GPU.** Headless Chromium renders with SwiftShader on the CPU, where the frame interval is dominated by fill rate (terrain, shadows and belts are full-screen layers) and other processes on the machine: compare `work` there, and compare `interval` only between runs on the same machine back to back. For real frame times, either run `PROFILE_GPU=1 npm run profile:render` on a desktop with a GPU (a headed Chromium; check that the report's renderer line names the GPU, not SwiftShader), or start `npm run dev` and open `http://localhost:5173/?scene=10k&profile=1` in any desktop browser: the report appears in a panel at the bottom left when it is done (about a minute) and as JSON in the console. Keep the window in front and at the size you want measured (the report lists it); a browser started with `--disable-gpu-vsync --disable-frame-rate-limit` shows intervals below 16.7 ms. The M4 target (docs/ARCHITECTURE.md, "Performance targets") is a steady 60 fps on the 10k scene: p99 interval under ~20 ms on every factory stage.

CI only runs a short smoke version (`tests/e2e/profile.spec.ts`, two stages on the `grid-1k` scene) so the profile keeps working; its numbers are not checked.

## Benchmarks

`npm run bench` is a headless tick-time benchmark of the simulation in Node. It bundles `tools/bench/run.ts` with Vite (so the simulation is compiled the way the game ships it) into `node_modules/.cache/beltworks-bench/`, then runs it with `node --expose-gc`.

For every scene, one run builds the scene from scratch, runs 600 untimed warm-up ticks, collects garbage, then times 3 600 ticks one by one. Each scene gets 3 untimed runs (V8 keeps optimizing for a while; on a 2-core CI runner the first run was up to 4× slower than the fifth), then 5 measured runs; the report shows the mean, p50, p99 and max tick time and the ticks per second (`1000 / mean`) of the run with the median mean (a 1k tick takes microseconds, so a single run swings by ±25% with one GC pause), as a Markdown table on stdout and optionally as JSON with every run's numbers. The heavy scenes (`10k`, `50k`) take milliseconds per tick and their builds already run thousands of ticks, so they default to 1 200 warm-up ticks, 3 measured runs and no untimed ones (`BenchScene.defaults`); the options below override any scene's defaults.

```sh
npm run bench                                   # the quick scenes (1k, power), Markdown table on stdout
npm run bench -- 10k                            # one scene by name (also: --scene 10k); 50k takes minutes
npm run bench -- --all                          # every scene, heavy ones included
npm run bench -- 1k --profile                   # add per-system timings (one extra profiled run)
npm run bench -- --scene 1k --json out.json    # also write JSON (--md for Markdown)
npm run bench -- --baseline tools/bench/baseline.json                    # compare; warns on > 20% slower mean
npm run bench -- --baseline tools/bench/baseline.json --update-baseline  # overwrite the baseline
```

Other options: `--warmup <ticks>`, `--ticks <ticks>`, `--runs <n>`, `--warmup-runs <n>`, `--threshold <ratio>` (default `0.2`), `--compare-md <file>`, `--fail-on-regression`. `npm run test:bench` runs the tests of the tooling itself (`tests/bench/`).

**Per-system timings** (`--profile`, `tools/bench/profile.ts`): after the measured runs, one more run builds the scene, warms it up the same way, and runs the measured ticks through `profiledStep`, which does what `Sim.step()` does but runs the systems itself and times each one with `performance.now()`. It lives in the benchmark only, so the game pays nothing for it. Three systems are split finer: drills (burner, electric), machines (furnaces, assembling machines, labs) and players (movement and hand-mining, hand-crafting). The report gets a table of the mean time per tick and share of each stage; the stage times include the timer calls (a dozen per tick, well under a microsecond), which matters for the microsecond-scale 1k and power scenes only, which is why the headline numbers come from the unprofiled runs. The profiled run must end in the same state hash as the measured ones, and the tests check that profiled ticks match `Sim.step()` and that `SYSTEMS` (src/sim/tick.ts) still has the systems the profiler knows: change the tick order and update `STAGES` with it.

**Scenes** (`tools/bench/scenes/`):

| Scene | Contents | Target mean |
|---|---|---|
| `1k` | 1 000 entities on seed `0xbe4c01`: 48 fuelled `drill → belt → inserter → furnace → inserter → chest` cells on the four starting ore patches, and 18 closed two-row belt loops (432 belts, 432 coal) with 56 exchange units below them (`loop → inserter → chest → inserter → chest → inserter → loop`), so coal keeps circulating; those inserters refuel from the coal they move. In total 480 belts, 264 burner inserters, 160 chests, 48 drills, 48 furnaces | < 1 ms |
| `power` | 959 entities on seed `0xbe4c02`: four electric districts, one around each starting ore patch and each its own network (districts are kept at least two blocks apart so their poles never connect), built from 5×5 blocks with a small electric pole on every block: plants (a boiler with steam engines end to end), 23 electric drills into chests with an electric inserter moving the ore on, and rings of four chests and four electric inserters passing coal around. Districts 0 and 2 have one engine (900 kW) and run overloaded (about 50% and 44% satisfaction), 1 and 3 two plants of two engines and power to spare. In total 10 steam engines, 6 boilers, 131 poles, 383 electric inserters, 23 electric drills, 406 chests | < 1 ms |
| `m3` | 1 170 entities on seed `0xbe4c4b`: ten columns, each a steam plant (a boiler with two engines, 1.8 MW) above four science cells and its own network. A cell: an iron chest of plates (and coal) → burner inserter → assembling machine making gears → fast inserter → assembling machine making red packs (copper plates over a long-handed inserter) → electric inserter → belt → underground pair → splitter → two belts → electric inserters → two labs, which get green packs from chests below them and research logistics 2 (its prerequisites researched from the start with `SimOptions.researched`; 30 s a unit, so it never finishes within a run). In total 80 assembling machines, 80 labs, 40 splitters, 80 undergrounds, 200 belts, 40 burner, 40 fast, 40 long-handed and 200 electric inserters, 160 iron chests, 200 poles | < 1 ms |
| `10k` (heavy) | 10 037 entities and about 50 000 items on belts on seed `0xbe4c13`: a steam-powered factory of 72 blocks (below: 52 buffer, 13 assembly, 3 lab, 4 smelting), built by 72 players | < 8 ms |
| `50k` (heavy) | 49 984 entities and about 260 000 items on belts on the same seed: the same blocks and mix, 346 of them (269 buffer, 67 assembly, 4 lab, 6 smelting), built by 346 players | < 16 ms |

The 1k and power scenes are built by four players (in the 1k scene one per ore patch plus a quarter of the belt blocks, in the power scene one per district) because one 40-slot inventory can't carry all the items and coal; every player gets the same starting kit, sized for the busiest builder. The power scene fuels its boilers last, once every district stands, so none burns coal during the build. Its report's `activity.powerSatisfaction` lists every network's satisfaction (percent, by network id). The m3 scene is built by ten players, one per column, and fuels its boilers last too (all within a few ticks), so every cell starts together; its cells run in step, so on a given tick its belts are all moving or all asleep.

**The 10k and 50k factories** (`tools/bench/scenes/factory.ts`) are built from 16×15-tile blocks on a lattice around the spawn; blocks that would cover water or a tree, or that can't be walked to, are left out, and the rest are taken nearest the spawn first until the scene has its entity count. Every block has its own steam plant (a boiler and one or two engines) on its west side and poles on its bottom row (an aisle the players walk and stand on), so neighbouring blocks wire up into large networks (two in both scenes), each with its own generation. The rest of a block is one of:

- **Buffer** (4 of every 5 general blocks): six closed two-row belt loops carrying copper cable, the outer two through an underground pair and two more joined by a splitter (a clockwise and a counter-clockwise loop whose middle rows both run into it), with two rows of electric and fast inserters passing cable between neighbouring loops both ways. Most of the belt items are here.
- **Assembly**: assembling machines 1 making automation science packs from a loop of gears (fed by a fast and a long-handed inserter each) and copper plates from a chest, assembling machines 2 making logistic science packs from a loop of transport belts and electric inserters from a chest, putting the packs back onto the loop with a long-handed inserter; burner inserters move the chest items and the red packs into output chests. Each loop carries one ingredient only: an inserter picks up anything its machine uses, so with both ingredients on one belt it would grab a third gear while the machine waits for copper, and stall.
- **Labs** (3 in 10k, 4 in 50k): two pack loops feeding eight labs through fast and long-handed inserters. The labs research logistics-2 (200 units of 30 s), which outlasts a run.
- **Smelting**, on blocks over ore: electric drills onto a belt that burner inserters feed into stone furnaces, emptied into chests; burner drills dropping into chests.

Belt tiers rotate from block to block (yellow, red, blue with their undergrounds and splitters). Loops are filled by hand, `Insert` on the middle of each belt every few ticks (4 rounds on yellow and red belts, 3 on blue ones, whose 24-subtile speed doesn't divide the 64-subtile spacing), leaving one belt in 24 and the undergrounds and splitters empty (and skipping a belt with no room at its middle, as happens behind a splitter): a full loop jams. (The holes are 3 to 4 item spots wide because inserters used to drop at one exact spot on the far lane; since #83 they use any free spot on their tile, so single spots would do too, but the scenes are kept as they are so their numbers stay comparable.) The builders are a crew (`tools/bench/crew.ts`): one player per block, all acting in the same ticks (each runs a generator that sends its commands and yields; a player waits while another stands where it wants to build), walking axis-aligned routes around water from the spawn. Once every block stands, every player fuels its boilers (and its smelting block's burners) in the same tick, so the whole factory starts at once and nothing runs down during the build; player 0 starts the research on the first tick. Each run checks the factory did real work during the measured ticks (`assertWork`): items reached the output chests, research units finished (and the research didn't), at least half the assembling machines, labs and engines are working, belts move, every network has power, and the belts still hold at least 45 000 items (10k) or 240 000 (50k). The report's `work` has the counters before and after the measured ticks (`beltItems`, `madeItems`, `researchUnits`).

Steady state: the loops keep their items (the only consumers, the assembling machines, take a gear or a belt every few seconds), so the 10k scene holds about 50 000 items on belts throughout. The buffer blocks' inserters pass cable until the far lanes they drop onto run out of holes; from then on most of them hold an item and wait, woken whenever items move past (see "Results").

**Rules for scenes:**

- Build through Commands only. `tools/bench/builder.ts` walks a player with `Move` commands to within build reach, then sends `Place` and `Insert` commands, stepping the simulation as it goes. It only reads state (player position, entity ids, inventory counts) to steer and to check that every command applied, and throws if one was ignored, so a scene can't silently shrink. The builders' items come from `SimOptions.startingKit` (and `SimOptions.players` for more than one builder).
- Stay deterministic: fixed seed, fixed layout, no randomness or clock in the scene. The report's `hash` is the state hash after the last measured tick; when it differs from the baseline's, the comparison says that the scene or the simulation changed.
- Keep the scene busy. The report's `activity` (machine states per entity type and active belt lanes after the last tick) shows whether the measured ticks did real work or slept; a scene can also read counters around the measured ticks (`probe`) and throw unless they show real work (`assertWork`).

**Adding a scene:**

1. Create `tools/bench/scenes/<name>.ts` exporting a `BenchScene` (`tools/bench/scene.ts`): a `name` for the command line and the reports, a `description`, the `targetMeanMs` from docs/ARCHITECTURE.md ("Performance targets"), and `build()`, which creates a `Sim` whose starting kit is exactly what the scene needs and builds the scene with a `Builder` (or a crew, for big scenes). Mark a scene that takes minutes `heavy` (it then runs nightly, not on every PR) and give it run `defaults`, and optionally `probe` and `assertWork`.
2. Add it to `SCENES` in `tools/bench/scenes/index.ts`.
3. Add a test to `tests/bench/` that checks its entity counts (and whatever the scene relies on, such as busy machines).
4. Add its numbers to the baseline (below): `tools/bench/baseline.json` for quick scenes, `tools/bench/baseline-nightly.json` for heavy ones.

**CI** (`.github/workflows/bench.yml`, separate from the main check and never blocking): on every PR and push to `main` the `bench` job runs the quick scenes with `--profile`, compares against `tools/bench/baseline.json`, writes the table, the per-system timings and the comparison to the job summary, uploads `bench-results/` (JSON and Markdown) as an artifact, and posts or updates a single comment on the PR. Every night (03:17 UTC) and on `workflow_dispatch` (on any branch: `gh workflow run bench.yml --ref <branch>`; tick "quick" to run the quick scenes too) the `bench-nightly` job runs `10k` and `50k` the same way against `tools/bench/baseline-nightly.json` and uploads `bench-results-nightly`; it takes about 2 minutes (each run builds its scene anew, 4 runs per scene with the profiled one). A mean tick time more than 20% over the baseline becomes a warning annotation. The main CI check runs `npm run test:bench` (which builds the 10k scene and runs it for a short while, but not the 50k one).

**Baseline:** `tools/bench/baseline.json` (quick scenes) and `tools/bench/baseline-nightly.json` (heavy scenes) are reports as `--json` writes them, recorded on GitHub's `ubuntu-latest` runners (local machines are not comparable). To refresh one after an intended change (a new scene, a scene change, a deliberate speed-up or slowdown), download `result.json` from the `bench-results` artifact of the PR's bench run (for the heavy scenes: dispatch the workflow on the PR's branch and use `bench-results-nightly`), copy it over the baseline, and commit it in the same PR. A tick of the 1k scene takes a few microseconds, so expect run-to-run noise on shared runners: a single warning is a reason to look, not proof of a regression. The `ubuntu-latest` pool also mixes CPU models (e.g. AMD EPYC 7763 and 9V74), which alone moved the 1k mean by about 40% on unchanged code; the comparison says so when the run's CPU differs from the baseline's.

**Results** (the committed baselines: the CI `workflow_dispatch` run of PR #80, Node 22 on 2-CPU `ubuntu-latest` runners, AMD EPYC 9V74 for the heavy scenes and 7763 for the quick ones):

| Scene | Entities | Items on belts (end of run) | Mean | p99 | Max | Target |
|---|---:|---:|---:|---:|---:|---|
| `1k` | 1 000 | 432 | 0.012 ms | 0.032 ms | 0.42 ms | < 1 ms, met |
| `power` | 959 | 0 | 0.074 ms | 0.171 ms | 0.56 ms | < 1 ms, met |
| `10k` | 10 037 | 50 076 | 0.47 ms | 0.71 ms | 0.89 ms | < 8 ms, met |
| `50k` | 49 984 | 259 507 | 3.05 ms | 4.20 ms | 6.99 ms | < 16 ms, met |

Per-system time per tick (`--profile`; ms, and share of the profiled tick, which includes the timer calls and runs a little slower than the measured ticks):

| System | `1k` | `power` | `10k` | `50k` |
|---|---:|---:|---:|---:|
| power | 0.0005 (3%) | 0.0309 (43%) | 0.094 (13%) | 0.288 (9%) |
| drills (burner + electric) | 0.0016 (10%) | 0.0023 (3%) | 0.004 (0.5%) | 0.004 (0.1%) |
| belts | 0.0022 (14%) | 0.0004 (1%) | 0.388 (55%) | 1.797 (55%) |
| inserters | 0.0093 (59%) | 0.0375 (52%) | 0.205 (29%) | 1.124 (35%) |
| furnaces + assemblers + labs | 0.0015 (10%) | 0.0006 (1%) | 0.016 (2%) | 0.041 (1%) |
| players, crafting, commands, events | 0.0007 (5%) | 0.0007 (1%) | 0.003 (0.4%) | 0.008 (0.3%) |
| total | 0.0159 | 0.0723 | 0.710 | 3.262 |

Both large scenes meet their targets by a wide margin on CI hardware; a 50k tick costs about 6.5 times a 10k one for 5 times the entities. Belts and inserters take over 80% of the tick, and power most of the rest:

- **Belts** (55%): every loop keeps moving, so all its lanes stay on the active list (about 560 lanes in 10k, 2 900 in 50k). Each moving lane also notifies the watched belts near the stretch that changed, and that wakes the inserters below.
- **Inserters** (29–35%): most of the buffer blocks' inserters hold an item and wait for a hole on the far lane they drop onto. (When this was measured, an inserter dropped at one exact spot, and the single free spots its neighbours leave when picking up never lined up with it; since #83 it drops into any free spot on its tile, so the lanes fill up further.) Every time items move past, the belt notification wakes them; they try, fail and go back to sleep. This is the busy-sparse-lane case from #17/#29, here on nearly full lanes. Idle machines are cheap: assemblers, labs, furnaces and drills stay between 0.1% and 3%.
- **Power** (9–13%, and 43% of the small power scene): the networks are solved every tick, even though nothing in them changes during the measured ticks.

These are the starting points for #73 (sleep/wake, incremental power solve), #75 (snapshot cost on the 10k scene) and #76 (WASM looks unnecessary for these targets on the current numbers).
