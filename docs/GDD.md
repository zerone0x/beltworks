# Game Design Document

## One line

Stranded on an alien planet, you start by mining ore by hand and build bigger and bigger automated production lines until you can launch a rocket home.

## Core experience

1. **The satisfaction of automation:** craft something once by hand, then make machines craft it ten thousand times.
2. **Logistics puzzles:** getting inputs to machines and outputs away, trading space for throughput.
3. **Expansion and rebuilding:** an old line can't keep up, so you tear it down or build a second one beside it.

## Core loop

```
explore/gather → hand-craft → place machines → connect logistics → research → unlock harder recipes → expand
```

## View and style

- Top-down 2D on a grid. One tile is 32 px at 1× zoom, and zoom is supported.
- Pixel or flat style, all original art. Industrial look: warm metal over cool ground.
- Machines have simple animations (2–8 frames). Belts scroll their texture.

## v1 scope (single-player)

### World
- Infinite procedurally generated map, generated chunk by chunk. A seed always produces the same map.
- Terrain: grass, sand, water (can't build on it), rock (can be removed and drops stone).
- Resources: iron ore, copper ore, coal, stone. (v1.x: crude oil.)
- Trees: can be chopped and drop wood.

### Player
- Move with WASD. Place and remove with the mouse. Inventory and hotbar.
- Hand-crafting queue; each recipe takes time.
- Build reach of about 10 tiles.

### Entities (v1)
| Category | Entities |
|---|---|
| Extraction | Burner mining drill, electric mining drill |
| Logistics | Transport belt (3 speed tiers), underground belt, splitter |
| Handling | Inserter (burner / electric / fast / long) |
| Processing | Stone furnace, assembler (2 tiers) |
| Storage | Wooden chest, iron chest |
| Power | Boiler, steam engine, small pole, medium pole (v1 skips real fluids: a boiler next to a steam engine counts as connected) |
| Research | Lab |

### Items and recipes
- About 30 items and 25 recipes in v1, defined as data tables (TS) so balancing is easy.
- Science packs: red (automation) and green (logistics). Blue comes in v1.x.

### Tech tree
- About 15 technology nodes in v1. Each one unlocks entities and recipes.

### Win condition
- v1: researching every green-science technology finishes the demo.
- Full game: launch a rocket.

## Non-goals for v1

- Enemies, combat, pollution
- Fluids (pipes, oil refining)
- Trains
- Circuit network
- Multiplayer (the architecture stays deterministic, see ARCHITECTURE.md)
- Mobile and touch input (desktop browsers first)
- Mod support

## Experience targets

- A new player builds their first automatic drill → furnace setup within 5 minutes.
- Red science is automated within 30 minutes.
- A 10k-entity factory keeps 60 UPS / 60 FPS in Chrome on a mid-range laptop.
