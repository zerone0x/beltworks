# Beltworks

A factory-automation game for the browser, inspired by Factorio. All art and names are original.

> Status: in development. Live build: https://zerone0x.github.io/beltworks-play/

Controls so far: drag with the middle mouse button or hold the arrow keys to pan, scroll to zoom. The debug overlay shows the tile under the mouse.

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
npm run typecheck  # tsc --noEmit
npm test           # Vitest unit tests (tests/sim, tests/worker, tests/render)
npm run build      # production build into dist/ (set BASE_PATH to change the base URL, default /)
npm run preview    # serve dist/
npm run test:e2e   # Playwright tests against a fresh test-mode build (Chromium)
```

Run `npx playwright install chromium` once before the first `npm run test:e2e`. The terrain screenshot baselines live in `tests/e2e/render.spec.ts-snapshots/`; after an intended visual change, regenerate them with `npx playwright test --update-snapshots` and check the new images.

## Deployment

The source repo is private. CI builds `main` and pushes `dist/` to the `gh-pages` branch of the public repo
[`zerone0x/beltworks-play`](https://github.com/zerone0x/beltworks-play), which serves it with GitHub Pages.
The build uses the base path `/beltworks-play/`, and pushes authenticate with the `DEPLOY_KEY` Actions secret, an SSH deploy key with write access to that repo.
This is done by `.github/workflows/deploy.yml` on every push to `main` (or manually via `workflow_dispatch`). The build ships without sourcemaps, since the deploy repo is public.

## Copyright

This project does not use any Factorio assets, names, sounds, or code. All art and audio is original or CC0.
