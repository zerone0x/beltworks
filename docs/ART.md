# Art

Beltworks' entities are pre-rendered 3D sprites, the way Factorio does it: every model is a procedural Blender script, rendered headless to PNG frames and packed into texture atlases that the game loads (docs/DECISIONS.md, D34). Anything without a model keeps its placeholder shape, so art lands one model at a time.

![The first sprites at 1× zoom](screenshots/art-first.png)

![Belts, inserters and poles at 1× zoom](screenshots/art-logistics.png)

## Style guide

- **Camera**: orthographic, looking down at 50° from the south. The image is stretched vertically by 1 / sin 50° (through the render's pixel aspect ratio), so the ground footprint of a model is square and lines up with the game's grid; 1 tile of height shows as 0.84 tile on screen. Never change this per model: every sprite in the game has to agree.
- **Light**: one warm key light (a sun, 4° wide for slightly soft edges) from the upper left, a little north of west and 50° up, plus a soft blue-gray sky. Tops are brightest, west faces next, south (front) faces are lit mostly by the sky: three clear tones that keep shapes readable at 1×. An invisible ground plane bounces a little light onto the lower parts.
- **Shadows** are a separate pass: the model, unseen by the camera, casts onto a shadow catcher. The game draws every shadow at full strength into one layer below all buildings and fades the layer as a whole (`SHADOW_ALPHA`, 0.5), so overlapping shadows don't get darker. Shadow texels under the opaque body are dropped by the packer.
- **Resolution**: 64 texels per tile. The game draws a tile as 32 world pixels, so sprites show at half scale at 1× zoom and texel for texel at 2×. Frames are trimmed on even texels, so at 1× they land on whole pixels. Atlases have mipmaps for zoomed-out views.
- **Silhouette first, detail second.** At 1× a 1×1 entity is 32 px wide: what reads is the outline, the big color areas and the light/shade split. Check every model at 1× in the game (or in the preview's 1× sheet) before adding detail. Details a few texels wide (rivets, slats) only show at 2×.
- **Materials**: slightly worn industrial surfaces from `bwart/materials.py`, all procedural (noise patterns over object coordinates, no image textures): painted steel with worn patches showing darker metal, dark iron, rusted iron, brass, rough stone, planked wood. Keep the wear subtle: strong blotches turn into camouflage at 1×.
- **Palette**: each entity family has one dominant color, so it is recognizable from its color alone. Burner tier: rust-red housing, brass gears, dark iron. Stone: warm gray-beige. Assembling machines: olive (tier 1), teal (tier 2). Logistics tiers will be yellow / red / blue (the colors of transport belts and fast/express ones). Fire and lamps are emissive; keep their strength near 1 so their color survives instead of clipping to flat white or yellow.
- **Original designs only**: nothing modeled after Factorio's (or anyone else's) art, no downloaded models or textures.

## Pipeline

```
art/blender/
  render.py               driver: renders every model × direction × layer × frame
  bwart/scene.py          camera, lights, world, render settings, projection constants
  bwart/materials.py      the material palette
  bwart/shapes.py         geometry helpers (box, cylinder, gear, pipe, ...), sprite layers
  bwart/assembler.py      shared builder of the assembling machine family
  bwart/belts.py          belt paths, the moving surface, side frames, underground hoods
  models/<model>.py       one procedural model per entity
  models/belts.py         every belt tier, shape and underground (MODELS: several per module)
  models/inserters.py     the four inserters, base and arm angles
tools/art/
  art.js                  `npm run art`: runs Blender, then packs
  pack.js                 trims, deduplicates and packs frames into atlases + JSON
  png.js                  dependency-free PNG reader/writer
  preview.js              contact sheet for looking at models
public/sprites/           the committed atlases: entities-0.png + entities.json (buildings),
                          logistics-0.png + logistics.json (belts, inserters, poles)
art/build/                renders and previews (scratch, not committed)
```

```sh
npm run art                        # render every model, rebuild the atlas from scratch
npm run art -- stone-furnace       # re-render one model, keep the others from the atlases
npm run art -- belts               # every model a module defines (models/belts.py)
npm run art -- --preview           # also write art/build/preview-2x.png and preview-1x.png
npm run art -- --samples 32 NAME   # quicker, noisier renders while iterating
npm run art -- --pack-only         # re-pack the renders in art/build/
```

**Blender**: 4.2 LTS, run headless (`-b --factory-startup -P art/blender/render.py -- ...`). `npm run art` takes it from the `BLENDER` environment variable (a Blender binary or a wrapper script); without it, `~/tools/blender.sh` (the dev machine's wrapper around a portable build, which sets `LD_LIBRARY_PATH` for libraries extracted without root) if it exists, else `blender` on the `PATH`. CI never runs Blender: the atlases are committed, and re-rendering is a manual step whenever a model changes.

**Render settings** (`bwart/scene.py`): Cycles on the CPU, 96 samples (no adaptive sampling), seed 0, OpenImageDenoise on the CPU (it has no random input; smooth surfaces also compress far better than sampling noise), Standard view transform, no dithering, transparent film. A full `npm run art` takes about 15 minutes on 4 cores (10 of them for the logistics models: 32 arm angles per inserter, 16 surface frames per belt shape and direction).

**Reproducibility**: the packer is byte-exact (same frames in, same PNG and JSON out), and a re-render gives the same pixels except for a handful of channels per frame that differ by 1/255 (Cycles' multithreaded float accumulation; also without the denoiser). So `npm run art` reproduces the committed atlas near-identically: within ±1 per channel on a few dozen texels per model, invisible, but not byte for byte.

**Sprite layers.** A model can be split into layers, drawn in order: `body` first (always shown), then overlays such as a furnace's fire or a machine's rotor. Each layer has its own frames, a frame rate, when it shows (`always`, or only while `working` / `idle`) and when it animates (`working`: on a clock per entity that runs while it works, at half speed on low power, so a machine that stops freezes in place; `always`: on the frame clock, e.g. flickering fire; `never`). The driver renders each layer on its own: the layers drawn before it are holdouts (they hide it where they stand in front, without showing themselves), the layers after it are left out. So only the moving part is rendered per frame, not the whole machine, which keeps the atlas small. Inserter arms (as angles) and the belt surface are layers too.

**Atlases.** A model goes into the atlas its `MODEL` names (`'atlas': 'logistics'`; default `entities`), one `<atlas>.json` with its sheets each; the game loads them all (`SPRITE_ATLASES` in `src/render/sprites.ts`) and merges their models. Families that change together share an atlas, so re-rendering one doesn't touch the others' files. A partial run only rewrites the atlases it rendered models for.

**Several models per module.** A module may define `MODELS`, a list of model dicts each with its own `build` (the belts: 3 surfaces, 3 shapes × 3 tiers of side frames, 2 hoods × 3 tiers). Other optional keys: `'shadow': False` on a model (no shadow pass; the packer stores an empty frame), `'extent': r` (render at least `r` tiles around the center, for parts that reach out of the footprint like a long arm), and on a layer `'shared': True` (rendered for the first direction only and used for all of them: frames that are angles in the world, not relative to the entity) and `'shadow': False` (left out of the shadow pass, for parts that move on their own). Objects go on the model's first layer unless a `layer` block says otherwise.

**Directions**: models are built facing north; the driver turns the model's root for east, south and west (`directions: 4`), so the light stays put and each direction is lit correctly.

**Points**: a model can name points in model space (`points: {'icon': (x, y, z)}`); the manifest and the atlas give them in texels from the footprint's center, per direction. The assembler layer draws a machine's product icon at its `icon` point (over the rotor's hub), the entity layer an inserter's held item at its `hand`, and the power layer hangs wires from a pole's `wire-west` / `wire-east`.

### Belts

![Every belt tier with an underground pair and a curve, at 1× zoom](screenshots/art-logistics-belts.png)

Every tier (yellow, red, blue) in `models/belts.py`, packed into the `logistics` atlas. A belt is three sprites, drawn by the belt layer (`src/render/beltLayer.ts`, `beltSprites.ts`), not the entity layer:

- the **moving surface**, `belt-surface` (`:curve-left`, `:curve-right` for curves): dark rubber with chevron slats pointing the way it moves, 4 slats per tile, the same for every tier. Its 16 frames cover one slat pitch, and the frame shown is how far the belt has moved since tick 0 (`ticks × beltSpeed / 256` tiles, between ticks too), so the slats run at exactly the items' speed: 2 frames a tick on a yellow belt, 4 on a red one, 6 on a blue one (still under half a pitch a tick, so it never looks like running backwards). No shadow: it is flat.
- the **side frames** in the tier color (the belt prototype's own model, with the curve suffixes), over the surface (no shadow: it would fall mostly on the belt, out of sight, and only cost fill rate);
- on an underground belt, the **hood** (`<underground>:entrance` / `:exit`) over its closed half, drawn above the items on belts (`coverContainer`), so items disappear into it. An entrance's mouth faces the incoming belt and its roof slopes down towards the ground; an exit is the mirror image; an arrow on the roof shows the direction either way.

Curves come in at the west (`curve-left`) or east (`curve-right`) edge of a north-facing tile and leave at the north edge, like `BeltShape.CurveFromLeft` / `CurveFromRight`; the paths are the game's (`beltPath.ts`), so items follow the drawn belt. The tier comes from the belt record's entity type, the underground mode from its `mode`; an underground belt's ghost shows the hood of what it would be (an entrance or an exit). Splitters: not yet.

### Inserters

`models/inserters.py`, in the `logistics` atlas: a static `body` (a footplate with a hazard chevron at the drop edge and the turret housing in the family color: rust-red burner with a firebox, blue electric, red fast, green long-handed) and an `arm` layer of 32 pre-rendered angles over a full turn (`shared`: the same frames for every direction, no shadow). The entity sprite layer draws inserters sorted in with the buildings, so one behind a tall machine is hidden by it: the base, then the arm sprite nearest to the arm's angle, turned the rest of the way (at most 5.6°) about the model's `pivot` point, so the swing is smooth, then the held item at the `hand` point (frame 0's hand, pointing east: its x is the reach, 0.8 tile or 1.8 for the long-handed inserter, its y the hand's height). The angle is the inserter layer's interpolation of the snapshots (`armAngle`, half a turn clockwise from the pickup tile to the drop tile).

### Poles

`models/small_electric_pole.py`, in the `logistics` atlas: a wooden post on a stone footing with a crossbar and two ceramic insulators, the `wire-west` and `wire-east` points. Wires (`src/render/powerLayer.ts`) hang from the insulator facing the other pole, as a parabola that sags 5% of their span, and cast a faint shadow on the ground (offset by their height along the light, `SHADOW_OFFSET`), drawn with the buildings' shadows.

### Atlas format

`public/sprites/<atlas>.json` (version 1):

```jsonc
{
  "version": 1,
  "tilePx": 64,                          // texels per tile
  "sheets": ["entities-0.png"],          // ≤ 4096² each
  "frames": [[0, 4, 4, 180, 210, 92, 140], ...], // [sheet, x, y, w, h, ax, ay]; (ax, ay): the footprint's center in the frame
  "models": {
    "burner-mining-drill": {
      "footprint": [2, 2],
      "directions": 4,
      "points": {},                      // name → [[x, y] texels from the center] per direction
      "shadow": [12, 13, 14, 15],        // one frame per direction
      "layers": [
        { "name": "body", "fps": 0, "show": "always", "advance": "working", "frames": [[0], [1], [2], [3]] },
        { "name": "head", "fps": 12, "show": "always", "advance": "working", "frames": [[...8 frames], ...] }
      ]
    }
  }
}
```

Models are keyed by entity prototype name (`src/data/entities.ts`), with a `:variant` suffix for the belt shapes and underground modes; `belt-surface` belongs to no entity. The runtime (`src/render/sprites.ts`, `entitySprites.ts`) loads the atlas at startup and falls back to the placeholder shapes until it has loaded, if it fails to load, and for every entity without a model. Identical frames are stored once. `tests/render/sprites.test.ts` checks the committed atlas against the prototypes (footprints, directions, layers).

## Adding a model

1. Create `art/blender/models/<entity_name>.py` with a `MODEL` dict and a `build(ctx)` function:

   ```python
   from bwart import materials as m
   from bwart.shapes import box, cylinder, layer

   MODEL = {
       'name': 'small-thing',              # the entity prototype's name
       'footprint': (1, 1),                # tiles, as in src/data/entities.ts
       'height': 0.8,                      # tallest point in tiles (frames the render)
       'directions': 1,                    # 4 for rotatable entities
       'layers': [
           {'name': 'body'},
           {'name': 'spin', 'frames': 8, 'fps': 12},  # animates while working
       ],
   }

   def build(ctx):
       box((0.8, 0.8, 0.5), (0, 0, 0.25), m.paint('thing', 0x8f8f62))
       with layer('spin'):
           cylinder(0.2, 0.1, (0, 0, 0.55), m.dark_iron(), rot=(0, 0, ctx.t('spin') * 3.1416))
   ```

   Build it facing north (+Y), standing on z = 0, footprint centered on the origin, one unit per tile. `ctx.t(layer)` is the animation phase (0..1) of the frame being rendered; make the last frame lead back into the first (turn a symmetric part by exactly one period).
2. `npm run art -- --samples 32 --preview small-thing` while iterating; look at `art/build/preview-1x.png` and `preview-2x.png` (idle and working, every direction, on grass). Then render it at full quality: `npm run art -- small-thing`.
3. Run the game (`npm run dev`) and look at it at 1× and 2× next to the other entities. If the layer needs a game-side rule (e.g. a new point), add it to the renderer.
4. Add the model to the list in `tests/render/sprites.test.ts` (or `logisticsSprites.test.ts` for the `logistics` atlas), and commit the model script with `public/sprites/`.
