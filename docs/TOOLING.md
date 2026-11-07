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
| `?art=1` / `?art=0` | The terrain's rendered look (D41) or the flat placeholder colors. Default: rendered in dev builds, placeholder in test builds, so the end-to-end specs that aren't about the art stay fast on CI's software renderer, where baking the rendered terrain is slow. The art, render and screenshot specs (`art.spec.ts`, `artLogistics.spec.ts`, `render.spec.ts`) pass `?art=1` |
| `?texels=8\|16\|32` | The most texels per tile the rendered terrain bakes at (implies `?art=1`); software renderers default to 16 (docs/ART.md, "Terrain") |

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

The Playwright suite (`tests/e2e/`, `npm run test:e2e`) drives a test-mode build (`vite build --mode test`: the production build plus the `window.__beltworks` test hook) with real keyboard and mouse input. Locally, Playwright builds it and serves it with `vite preview`; `npx playwright test --shard 2/4` runs one shard the way CI does.

**CI** (`.github/workflows/ci.yml`) splits the suite so it doesn't run in one long job:

| Job | What it does |
|---|---|
| `check` | Lint, typecheck, unit tests (including the Node half of the determinism check), benchmark tooling tests, production build |
| `e2e-build` | Builds the test bundle once (`npm run build:test`) and uploads `dist/` as the `e2e-dist` artifact |
| `e2e-shard (i/4)` | Four shards in parallel, each `npx playwright test --shard i/4` against the downloaded bundle (`E2E_PREBUILT=1` makes the config only serve `dist/`, not build it), one worker each, 15 min timeout; each uploads a blob report and its `test-results/` (screenshots, failure context) |
| `e2e` | Waits for the shards (`if: always()`), merges their blob reports into one HTML report (`npx playwright merge-reports`, the `playwright-report` artifact), and fails unless the build and every shard passed. This is the one status to require for the e2e suite |

Playwright shards by test count, in file order (`fullyParallel` makes every test its own unit), so each test runs in exactly one shard; in particular the Chromium half of the determinism check (`determinism.spec.ts`, Node == Chromium) runs once per CI run, and the Node half once in `check`. Every spec asks for what it needs in its own URL (`?kit=`, `?research=`, and `?art=1` / `?texels=` for the rendered terrain in the art and render specs; see "Dev and test URL parameters"), so a spec runs the same whichever shard it lands in. Shards are balanced by count, not time: a long new spec makes its shard longer, so keep an eye on the per-shard times in the run summary and add a shard (a matrix entry and `total`) when the slowest one nears 10 minutes.

**Keeping specs short.** CI's Chromium renders in software on 2 vCPUs, sometimes at 7 fps, so walking and clicking are slow and every second of simulated time is a second of wall time. When a spec waits on a long process while the player stands still (research, mining, measuring a production rate), run the simulation faster with `fastForward` / `setTimeScale` from `tests/e2e/timeScale.ts` (the test hook's `setTimeScale`, dev and test builds only; D42), and go back to normal speed before walking or building again: the player walks faster too. It changes only how many ticks run per second, so anything measured in ticks or game state stays exact; avoid it where a check polls for a short-lived state once per rendered frame. Build near the spawn with a `?kit=` (D29) or `?research=` (D38) start rather than walking or crafting there when the walk or the crafting isn't what the spec tests.

## Benchmarks

`npm run bench` is a headless tick-time benchmark of the simulation in Node. It bundles `tools/bench/run.ts` with Vite (so the simulation is compiled the way the game ships it) into `node_modules/.cache/beltworks-bench/`, then runs it with `node --expose-gc`.

For every scene, one run builds the scene from scratch, runs 600 untimed warm-up ticks, collects garbage, then times 3 600 ticks one by one. Each scene gets 3 untimed runs (V8 keeps optimizing for a while; on a 2-core CI runner the first run was up to 4× slower than the fifth), then 5 measured runs; the report shows the mean, p50, p99 and max tick time and the ticks per second (`1000 / mean`) of the run with the median mean (a 1k tick takes microseconds, so a single run swings by ±25% with one GC pause), as a Markdown table on stdout and optionally as JSON with every run's numbers.

```sh
npm run bench                                   # all scenes, Markdown table on stdout
npm run bench -- --scene 1k --json out.json    # one scene, also write JSON (--md for Markdown)
npm run bench -- --baseline tools/bench/baseline.json                    # compare; warns on > 20% slower mean
npm run bench -- --baseline tools/bench/baseline.json --update-baseline  # overwrite the baseline
```

Other options: `--warmup <ticks>`, `--ticks <ticks>`, `--runs <n>`, `--warmup-runs <n>`, `--threshold <ratio>` (default `0.2`), `--compare-md <file>`, `--fail-on-regression`. `npm run test:bench` runs the tests of the tooling itself (`tests/bench/`).

**Scenes** (`tools/bench/scenes/`):

| Scene | Contents | Target mean |
|---|---|---|
| `1k` | 1 000 entities on seed `0xbe4c01`: 48 fuelled `drill → belt → inserter → furnace → inserter → chest` cells on the four starting ore patches, and 18 closed two-row belt loops (432 belts, 432 coal) with 56 exchange units below them (`loop → inserter → chest → inserter → chest → inserter → loop`), so coal keeps circulating; those inserters refuel from the coal they move. In total 480 belts, 264 burner inserters, 160 chests, 48 drills, 48 furnaces | < 1 ms |
| `power` | 959 entities on seed `0xbe4c02`: four electric districts, one around each starting ore patch and each its own network (districts are kept at least two blocks apart so their poles never connect), built from 5×5 blocks with a small electric pole on every block: plants (a boiler with steam engines end to end), 23 electric drills into chests with an electric inserter moving the ore on, and rings of four chests and four electric inserters passing coal around. Districts 0 and 2 have one engine (900 kW) and run overloaded (about 50% and 44% satisfaction), 1 and 3 two plants of two engines and power to spare. In total 10 steam engines, 6 boilers, 131 poles, 383 electric inserters, 23 electric drills, 406 chests | < 1 ms |

Both scenes are built by four players (in the 1k scene one per ore patch plus a quarter of the belt blocks, in the power scene one per district) because one 40-slot inventory can't carry all the items and coal; every player gets the same starting kit, sized for the busiest builder. The power scene fuels its boilers last, once every district stands, so none burns coal during the build. Its report's `activity.powerSatisfaction` lists every network's satisfaction (percent, by network id).

**Rules for scenes:**

- Build through Commands only. `tools/bench/builder.ts` walks a player with `Move` commands to within build reach, then sends `Place` and `Insert` commands, stepping the simulation as it goes. It only reads state (player position, entity ids, inventory counts) to steer and to check that every command applied, and throws if one was ignored, so a scene can't silently shrink. The builders' items come from `SimOptions.startingKit` (and `SimOptions.players` for more than one builder).
- Stay deterministic: fixed seed, fixed layout, no randomness or clock in the scene. The report's `hash` is the state hash after the last measured tick; when it differs from the baseline's, the comparison says that the scene or the simulation changed.
- Keep the scene busy. The report's `activity` (machine states per entity type and active belt lanes after the last tick) shows whether the measured ticks did real work or slept.

**Adding a scene:**

1. Create `tools/bench/scenes/<name>.ts` exporting a `BenchScene` (`tools/bench/scene.ts`): a `name` for the command line and the reports, a `description`, the `targetMeanMs` from docs/ARCHITECTURE.md ("Performance targets"), and `build()`, which creates a `Sim` whose starting kit is exactly what the scene needs and builds the scene with a `Builder`.
2. Add it to `SCENES` in `tools/bench/scenes/index.ts`.
3. Add a test to `tests/bench/` that checks its entity counts (and whatever the scene relies on, such as busy machines).
4. Add its numbers to the baseline (below).

**CI** (`.github/workflows/bench.yml`, separate from the main check and never blocking): on every PR and push to `main` it runs the benchmark, compares against `tools/bench/baseline.json`, writes the table and the comparison to the job summary, uploads `bench-results/` (JSON and Markdown) as an artifact, and posts or updates a single comment on the PR. A mean tick time more than 20% over the baseline becomes a warning annotation. The main CI check runs `npm run test:bench`.

**Baseline:** `tools/bench/baseline.json` is a report as `--json` writes it, recorded on GitHub's `ubuntu-latest` runners (local machines are not comparable). To refresh it after an intended change (a new scene, a scene change, a deliberate speed-up or slowdown), download `result.json` from the `bench-results` artifact of the PR's bench run, copy it to `tools/bench/baseline.json`, and commit it in the same PR. A tick of the 1k scene takes a few microseconds, so expect run-to-run noise on shared runners: a single warning is a reason to look, not proof of a regression. The `ubuntu-latest` pool also mixes CPU models (e.g. AMD EPYC 7763 and 9V74), which alone moved the 1k mean by about 40% on unchanged code; the comparison says so when the run's CPU differs from the baseline's.
