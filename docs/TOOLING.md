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

- [Aseprite](https://github.com/aseprite/aseprite) / [Pixelorama](https://github.com/Orama-Interactive/Pixelorama): sprites, tilesets, animation
- Until real art exists, use placeholders drawn in code (colored shapes) or generated images cleaned up by hand

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
| `1k` | 1 000 entities on seed `0xbe4c01`: 48 drill → furnace → chest cells on the four starting ore patches (fuelled; the drills mine into the furnaces), and 30 closed two-row belt loops (720 belts, 720 iron plates circulating) with 136 chests beside them | < 1 ms |

Every scene leaves an empty **inserter spot** wherever an inserter belongs (between each furnace and its chest, and between each loop and its chests; `inserterSpots()` in `tools/bench/scenes/factory1k.ts` lists them). Once burner inserters are simulated, place them there and refresh the baseline.

**Rules for scenes:**

- Build through Commands only. `tools/bench/builder.ts` walks the player with `Move` commands to within build reach, then sends `Place` and `Insert` commands, stepping the simulation as it goes. It only reads state (player position, entity ids, inventory counts) to steer and to check that every command applied, and throws if one was ignored, so a scene can't silently shrink. The builder's items come from `SimOptions.startingKit`.
- Stay deterministic: fixed seed, fixed layout, no randomness or clock in the scene. The report's `hash` is the state hash after the last measured tick; when it differs from the baseline's, the comparison says that the scene or the simulation changed.
- Keep the scene busy. The report's `activity` (machine states per entity type and active belt lanes after the last tick) shows whether the measured ticks did real work or slept.

**Adding a scene:**

1. Create `tools/bench/scenes/<name>.ts` exporting a `BenchScene` (`tools/bench/scene.ts`): a `name` for the command line and the reports, a `description`, the `targetMeanMs` from docs/ARCHITECTURE.md ("Performance targets"), and `build()`, which creates a `Sim` whose starting kit is exactly what the scene needs and builds the scene with a `Builder`.
2. Add it to `SCENES` in `tools/bench/scenes/index.ts`.
3. Add a test to `tests/bench/` that checks its entity counts (and whatever the scene relies on, such as busy machines).
4. Add its numbers to the baseline (below).

**CI** (`.github/workflows/bench.yml`, separate from the main check and never blocking): on every PR and push to `main` it runs the benchmark, compares against `tools/bench/baseline.json`, writes the table and the comparison to the job summary, uploads `bench-results/` (JSON and Markdown) as an artifact, and posts or updates a single comment on the PR. A mean tick time more than 20% over the baseline becomes a warning annotation. The main CI check runs `npm run test:bench`.

**Baseline:** `tools/bench/baseline.json` is a report as `--json` writes it, recorded on GitHub's `ubuntu-latest` runners (local machines are not comparable). To refresh it after an intended change (a new scene, a scene change, a deliberate speed-up or slowdown), download `result.json` from the `bench-results` artifact of the PR's bench run, copy it to `tools/bench/baseline.json`, and commit it in the same PR. A tick of the 1k scene takes a few microseconds, so expect run-to-run noise on shared runners: a single warning is a reason to look, not proof of a regression. The `ubuntu-latest` pool also mixes CPU models (e.g. AMD EPYC 7763 and 9V74), which alone moved the 1k mean by about 40% on unchanged code; the comparison says so when the run's CPU differs from the baseline's.
