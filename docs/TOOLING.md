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
- Every PR passes the unit tests and the determinism test. A PR that touches a simulation hot path includes benchmark results.
- A PR that changes visuals includes Playwright screenshots.
- Commit messages and PR titles use conventional commits: `<type>(<scope>): <subject>`.
