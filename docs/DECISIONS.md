# Decision log

## Decided

| # | Decision | Why |
|---|---|---|
| D1 | Top-down 2D on a grid | Least work, and the gameplay doesn't need 3D |
| D2 | PixiJS v8 rather than Phaser | Only a renderer is needed; physics and scene management would go unused, and PixiJS batches sprites more lightly and quickly |
| D3 | The simulation runs in a Web Worker | The main thread only renders and handles input, so the game doesn't stutter |
| D4 | Integer-only, deterministic simulation | Reliable saves, replay debugging, room for multiplayer |
| D5 | Belts are transport lines with gap arrays | The only approach proven to scale |
| D6 | TypeScript first, with data laid out as TypedArrays | Fast iteration, cheap to move to WASM if needed |
| D7 | v1 is single-player with no combat or fluids | Keeps the focus on the core loop |
| D8 | Original names and art | Avoids copyright problems |
| D9 | Private source repo, public deploy repo `beltworks-play` on GitHub Pages | GitHub Pages isn't available for private repos on the current plan |

## Open

| # | Question | Decide when |
|---|---|---|
| Q1 | UI: plain DOM or Preact | When the UI grows past the inventory (M2) |
| Q2 | Snapshot transfer: transferable buffers or SharedArrayBuffer (needs COOP/COEP) | After the M4 benchmarks |
| Q3 | Whether and when to move to Rust→WASM | M4 |
| Q4 | Final art style (pixel or flat vector) | Before the end of M1; placeholders until then |
| Q5 | Final name (working title: Beltworks) | Before the public beta |
