# Beltworks

A factory-automation game for the browser, inspired by Factorio. All art and names are original.

> Status: in development (M1, the core automation loop, is done). Live build: https://zerone0x.github.io/beltworks-play/

## Playing

A new game starts between four ore patches (iron, copper, coal, stone) with a kit of belts, burner inserters, burner mining drills, stone furnaces, wooden chests and coal in the hotbar. The first goal: a drill on iron ore drops ore onto a belt, an inserter feeds it into a furnace, and another inserter moves the plates into a chest, all on their own once fuelled with coal.

![The M1 chain: a burner mining drill on iron ore, a belt, an inserter, a furnace, an inserter and a chest filling with iron plates](docs/screenshots/m1-chain.png)

Press **H** in the game (or click the hint in the bottom-left corner) for a list of the controls. In full:

- **WASD**: walk (water blocks the way). The camera follows the player.
- **Hold right mouse** on an ore tile within reach (2.5 tiles): mine it by hand, one unit every 0.5 s.
- **E**: open or close the inventory (40 slots; the first 10 are shown in the hotbar at the bottom). With an entity window open, **E** closes it instead.
- **Crafting** (in the inventory window): each hand recipe shows how many you can craft; **click** crafts 1, **shift-click** 5. Ingredients are taken when the craft is queued, and missing intermediates (gears, a furnace for a drill) are queued first. The queue shows above the hotbar; **click** an entry to cancel it and get its ingredients back.
- **1–0**: select a hotbar slot (press it again, or **Q**, to deselect). A new game starts with a kit of belts, inserters, drills, furnaces, chests and coal.
- With a buildable item selected, a **ghost** follows the cursor: green where it can be placed, red where it can't (water, another entity, the player, or out of build reach, 10 tiles). **R** rotates it, **left click** places it (hold and drag to place a row).
- **R** with nothing selected rotates the entity under the cursor.
- **Left click** on a chest, furnace, mining drill or inserter with nothing to build selected opens its window (in place of the inventory window): click a stack in your inventory to put all of it in (coal and wood go to a furnace's, drill's or inserter's fuel slot, ores and stone to a furnace's input), **right-click** it to put in half (rounded up), click one of its slots to take the contents. **Esc** (or **E**) closes it. A furnace smelts iron ore, copper ore, or two stone into a plate or brick every 3.2 s while it has fuel; its firebox glows while it works.
- A **burner mining drill** placed on ore mines one unit every 4 s while it has fuel, from the four tiles under it in turn, and puts it into the entity in front of it (the arrow shows which way it faces; a chest stores it, a furnace smelts it). With nothing there, or no room, it holds the unit and waits. Its ring lights up while it works; its window shows its fuel and whether it is working, out of fuel, blocked, or depleted.
- A **burner inserter** takes one item at a time from the tile behind it and puts it onto the tile in front of it (the way its arrow points): out of a chest, a furnace's output, a drill or a belt, into a chest, a furnace (ores to the input, coal to the fuel), a drill (fuel only) or onto the far lane of a belt. A swing there and back takes 1.2 s and burns fuel only while the arm moves. With an empty fuel slot it takes one unit of coal from its source for itself, so an inserter next to coal starts on its own. Its window shows its fuel, the arm's position, the item in its hand, and whether it is swinging, out of fuel, or waiting for its source or target.
- **Belts** move items towards the way they face. Belts in a row join up, a belt fed only from one side turns, and a belt pointing into the side of another feeds that side's lane. Removing a belt gives back the items on it.
- **Right click** on an entity removes it and puts it back into the inventory, together with what it holds (refused if there is no room); elsewhere the right button mines as above.
- **Middle-drag** or **arrow keys**: pan the camera freely; **F**: follow the player again.
- **Mouse wheel**: zoom (towards the cursor with a free camera, around the player while following).
- **H**: show or hide the list of controls.

The debug overlay shows the tile under the mouse.

![The player mining copper ore with the inventory open](docs/screenshots/m0-player.png)

![Placed entities and the ghost preview of a transport belt](docs/screenshots/m1-placement.png)

![A working stone furnace and its window](docs/screenshots/m1-furnace.png)

![A burner mining drill on iron ore feeding a furnace, with the drill's window](docs/screenshots/m1-drill.png)

![Hand-crafting stone furnaces from mined stone, with the queue above the hotbar](docs/screenshots/m1-crafting.png)

![Coal on a belt line with a curve and a side-loading belt](docs/screenshots/m1-belts.png)

![A burner inserter swinging coal from one chest to another, with its window](docs/screenshots/m1-inserter.png)

## Docs

| Doc | Contents |
|---|---|
| [docs/GDD.md](docs/GDD.md) | Game design: core loop, scope, non-goals |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Simulation core, rendering, data layout, determinism |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones and acceptance criteria |
| [docs/TOOLING.md](docs/TOOLING.md) | Toolchain, references, development rules |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decisions made and open questions |

## Development

Requires Node.js 22 (see `.nvmrc`).

```sh
npm ci
npm run dev        # start the Vite dev server
npm run lint       # ESLint (including the src/sim purity rules) + Prettier check
npm run typecheck  # tsc --noEmit (app and tools/bench)
npm test           # Vitest unit tests (tests/sim, tests/worker, tests/render)
npm run test:bench # Vitest tests of the benchmark tooling (tests/bench)
npm run bench      # headless tick-time benchmark (see docs/TOOLING.md, "Benchmarks")
npm run build      # production build into dist/ (set BASE_PATH to change the base URL, default /)
npm run preview    # serve dist/
npm run test:e2e   # Playwright tests against a fresh test-mode build (Chromium)
```

Run `npx playwright install chromium` once before the first `npm run test:e2e`. The screenshot baselines live in `tests/e2e/render.spec.ts-snapshots/`; after an intended visual change, regenerate them with `npx playwright test --update-snapshots` and check the new images.

## Deployment

The source repo is private. CI builds `main` and pushes `dist/` to the `gh-pages` branch of the public repo
[`zerone0x/beltworks-play`](https://github.com/zerone0x/beltworks-play), which serves it with GitHub Pages.
The build uses the base path `/beltworks-play/`, and pushes authenticate with the `DEPLOY_KEY` Actions secret, an SSH deploy key with write access to that repo.
This is done by `.github/workflows/deploy.yml` on every push to `main` (or manually via `workflow_dispatch`). The build ships without sourcemaps, since the deploy repo is public.

## Copyright

This project does not use any Factorio assets, names, sounds, or code. All art and audio is original or CC0.
