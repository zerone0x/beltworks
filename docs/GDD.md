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
- Belts carry the player standing on them at the belt's speed, like Factorio's.
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
- Science packs: red (automation), green (logistics) and military (D76). Blue comes in v1.x.
- Military content (D76), Factorio 1.1's recipes: steel plate (5 iron plates in a furnace, 16 s), stone wall (5 bricks, 0.5 s), firearm magazine (4 iron plates, 1 s), piercing rounds magazine (firearm magazine + steel + 5 copper plates, 3 s), grenade (10 coal + 5 iron plates, 8 s). There is no combat in v1 (D7): walls, magazines and grenades are ingredients of the military science pack, nothing places or fires them.

### Tech tree
- Technologies are researched in labs from science packs (`src/data/technologies.ts`); each one unlocks recipes. Everything from M1 and M2, the lab and the automation science pack are available from the start. About 15 nodes in v1; the M3 tree has 8, and more come with the mechanics they unlock (bonuses such as inserter capacity need their effects first). After the last of them comes **research speed**, a repeatable technology like Factorio's infinite ones (D74): it has levels and no last level, level n costs 100 × n units, and each level done makes labs 10 % faster, so labs always have something to research.

| Technology | Requires | Cost per unit | Units × time | Unlocks |
|---|---|---|---|---|
| Automation | — | red | 10 × 10 s | Assembling machine 1, long-handed inserter |
| Logistics | — | red | 20 × 15 s | Underground belt, splitter |
| Electronics | Automation | red | 30 × 15 s | — (leads to fast inserter, automation 2) |
| Fast inserter | Electronics | red | 30 × 15 s | Fast inserter |
| Logistic science pack | Automation | red | 75 × 5 s | Logistic science pack |
| Automation 2 | Electronics, logistic science pack | red + green | 40 × 5 s | Assembling machine 2 |
| Logistics 2 | Logistics, logistic science pack | red + green | 200 × 30 s | Fast transport belt, fast underground belt, fast splitter |
| Logistics 3 | Logistics 2, automation 2 | red + green | 300 × 15 s | Express transport belt, express underground belt, express splitter |
| Research speed (repeatable, D74) | Fast inserter, logistics 3 | red + green | level n: 100 × n × 15 s | Each level: labs research 10 % faster |
| Military (D76) | — | red | 10 × 15 s | — (leads to military 2) |
| Stone wall | — | red | 10 × 10 s | Stone wall |
| Steel processing | — | red | 50 × 5 s | Steel plate (furnaces take iron plates only from then on) |
| Military 2 | Military, steel processing, logistic science pack | red + green | 20 × 15 s | Piercing rounds magazine, grenade |
| Military science pack | Military 2, stone wall | red + green | 30 × 15 s | Military science pack |

Research speed stays red + green until the demo factory makes military packs (D76): nothing costs military packs yet; the demo redesign (#146) moves research speed onto red + green + military, a one-line data change.

Science packs: automation (red) = 1 copper plate + 1 iron gear wheel, 5 s; logistic (green) = 1 electric inserter + 1 transport belt, 6 s; military = 1 piercing rounds magazine + 1 grenade + 2 stone walls → 2 packs, 10 s. A lab (3×3, 60 kW) holds a stack of each and researches one unit at a time; several labs add up.

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
