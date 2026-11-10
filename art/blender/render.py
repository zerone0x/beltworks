"""
Renders the sprite models under art/blender/models/ to PNG frames.

    blender -b --factory-startup -P art/blender/render.py -- --out art/build [--samples 96] [name ...]

`npm run art` runs this (through $BLENDER) and then packs the frames into
atlases with tools/art/pack.js; see docs/ART.md.

Every model module defines `MODEL` (name, footprint, height, directions and
sprite layers in draw order) and `build(ctx)`, which creates the model facing
north with the helpers in bwart/. For each direction the driver renders a
shadow frame (the whole model, unseen by the camera, onto a shadow catcher)
and then each layer's frames on their own: the layers drawn before it hide
it where they stand in front (holdouts), the layers drawn after it are left
out. A model can also name `points` (x, y, z in
tiles), e.g. where the game draws an assembler's product icon; the manifest
gives them in texels from the footprint's center, per direction. Output per
model in <out>/<name>/: `<layer>-d<dir>-f<frame>.png` and a
`manifest.json` the packer reads.

A module can define several models at once with `MODELS`, a list of model
dicts that each carry their own `build` (e.g. every belt tier and shape from
one script; without one, the module's `build`). Optional model keys:

- `atlas`: the atlas it is packed into (default `entities`), so groups of
  models (logistics, power, terrain, icons, ...) get their own sheets and
  index and can be re-rendered on their own.
- `shadow`: `True` (a separate shadow pass, the default); `False`, no shadow
  at all (e.g. a belt surface); or `'catch'`, the body pass catches the
  model's own shadow (flat decals on the ground, like ore, that never
  overlap each other), with no shadow frame.
- `extent`: tiles around the center the render must cover, for parts that
  reach beyond the footprint like a long inserter arm; `margin` and
  `shadow_reach` (tiles) tighten or widen the frame.
- `variants`: render the model N times, as `<name>-0` .. `<name>-<N-1>`;
  `ctx.variant` tells `build` which one it is building.
- `kind`: `'sprite'` (the default); `'ground'`, a seamless ground texture of
  `period` x `period` tiles seen through the game camera (opaque, and without
  the denoiser, which can't see across the edges and would break the
  periodicity); or `'icon'`, an item icon (for `item`) framed to fit a
  square (with `from`: the idle body of another model, e.g. an entity's own).

Optional layer keys: `shared` (True: rendered for the first direction only
and used for every direction, e.g. an inserter arm whose frames are angles
in the world, not relative to the entity) and `shadow` (False: left out of
the shadow pass, for parts that move independently of the shadow).

Names on the command line pick a model, every variant of a model, every model
of a module (by file name, e.g. `belts`) or of an atlas (e.g. `terrain`).
"""

import argparse
import importlib.util
import json
import math
import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from bwart import scene, shapes  # noqa: E402

MODELS_DIR = os.path.join(HERE, 'models')
SHADOW = 'shadow'
#: Item icons are rendered at this size; the packer box-filters them to half of it.
ICON_RENDER_PX = 104


class Context:
    """
    What a model's `build` gets: the direction, the animation phase of the
    layer being rendered, which variant it is, and the model's dict.
    """

    def __init__(self, direction, layer, frame, frames):
        self.direction = direction
        self.layer = layer
        self.frame = frame
        self.frames = frames
        self.variant = 0
        self.model = {}

    def t(self, layer):
        """Animation phase (0..1, exclusive) of `layer` in this frame; 0 unless it is the one rendered."""
        if layer != self.layer or self.frames <= 1:
            return 0.0
        return self.frame / self.frames

    def frame_of(self, layer):
        return self.frame if layer == self.layer else 0


class Model:
    """One model to render (one variant of a model dict), and how to build it."""

    def __init__(self, spec, build, variant, name, module):
        self.MODEL = dict(spec, name=name)
        self.base = spec['name']
        self.variant = variant
        self.module = module
        self._build = build

    def build(self, ctx):
        ctx.variant = self.variant
        ctx.model = self.MODEL
        self._build(ctx)


def load_models():
    """Every model by name."""
    models = {}
    for file in sorted(os.listdir(MODELS_DIR)):
        if not file.endswith('.py') or file.startswith('_'):
            continue
        spec = importlib.util.spec_from_file_location('bw_model_' + file[:-3], os.path.join(MODELS_DIR, file))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for model in getattr(module, 'MODELS', None) or [module.MODEL]:
            build = model.get('build') or getattr(module, 'build', None)
            variants = model.get('variants', 1)
            for v in range(variants):
                name = model['name'] if variants == 1 else f'{model["name"]}-{v}'
                if name in models:
                    raise ValueError(f'model {name} is defined twice ({file})')
                models[name] = Model(model, build, v, name, file[:-3])
    return models


def matches(name, model):
    """Whether command line `name` picks `model`: by name, base name, module or atlas."""
    return name in (model.MODEL['name'], model.base, model.module, model.MODEL.get('atlas', 'entities'))


def layer_specs(model):
    specs = []
    for spec in model.get('layers', [{'name': 'body'}]):
        specs.append(
            {
                'name': spec['name'],
                'frames': spec.get('frames', 1),
                'fps': spec.get('fps', 0),
                # When the layer is drawn: 'always', or only while the entity is 'working' / 'idle'.
                'show': spec.get('show', 'always'),
                # Whether the animation advances only while working, or all the time.
                'advance': spec.get('advance', 'working'),
                # Rendered once (first direction) and used for every direction.
                'shared': spec.get('shared', False),
                'shadow': spec.get('shadow', True),
            }
        )
    return specs


def render_frame(module, bounds, size, samples, direction, layer, frame, frames, path):
    scene.clear()
    specs = layer_specs(module.MODEL)
    shapes.reset(specs[0]['name'])
    scene.setup_render(size[0], size[1], samples)
    scene.setup_camera(bounds)
    scene.setup_lights()
    catch = layer == SHADOW or module.MODEL.get('shadow', True) == 'catch'
    scene.add_ground(shadow_catcher=catch)
    module.build(Context(direction, layer, frame, frames))
    root = shapes.root()
    root.rotation_euler = (0.0, 0.0, turn(direction, module.MODEL.get('directions', 1)))
    order = [spec['name'] for spec in specs]
    current = order.index(layer) if layer != SHADOW else -1
    for obj in bpy.data.objects:
        tag = obj.get('bw_layer')
        if tag is None or tag.startswith('__'):
            continue
        if tag not in order:
            raise ValueError(f'{module.MODEL["name"]}: object {obj.name} is on unknown layer {tag}')
        index = order.index(tag)
        if layer == SHADOW:
            obj.visible_camera = False
            if not specs[index]['shadow']:
                obj.hide_render = True
        elif index < current:
            obj.is_holdout = True
        elif index > current:
            obj.hide_render = True
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def turn(direction, directions):
    """
    How far the root turns (radians about Z) for `direction` out of
    `directions`: clockwise seen from above, in equal steps from north (a
    quarter turn each for the 4 directions of a building, an eighth for the
    8 of the player).
    """
    return -direction * 2 * math.pi / max(directions, 4)


def project(point, direction, directions):
    """Where model point (x, y, z) shows, in texels from the footprint's center, for `direction`."""
    x, y, z = point
    a = turn(direction, directions)
    rx = x * math.cos(a) - y * math.sin(a)
    ry = x * math.sin(a) + y * math.cos(a)
    return [round(rx * scene.TILE_PX, 2), round((-ry - z * scene.HEIGHT_ON_SCREEN) * scene.TILE_PX, 2)]


def prepare_target(out_dir, name):
    """An empty <out>/<name>/ directory."""
    target = os.path.join(out_dir, name)
    os.makedirs(target, exist_ok=True)
    for file in os.listdir(target):
        os.remove(os.path.join(target, file))
    return target


def render_model(module, out_dir, samples):
    model = module.MODEL
    name = model['name']
    bounds = scene.screen_bounds(
        tuple(model['footprint']),
        model['height'],
        margin=model.get('margin', 0.25),
        extent=model.get('extent', 0.0),
        reach=model.get('shadow_reach'),
    )
    size = (
        round((bounds[2] - bounds[0]) * scene.TILE_PX),
        round((bounds[3] - bounds[1]) * scene.TILE_PX),
    )
    anchor = (round(-bounds[0] * scene.TILE_PX), round(-bounds[1] * scene.TILE_PX))
    target = prepare_target(out_dir, name)
    layers = layer_specs(model)
    directions = model.get('directions', 1)
    started = time.time()
    count = 0
    # Only `True` gets a shadow pass; `'catch'` and `False` have no shadow frame.
    shadow = model.get('shadow', True) is True
    for d in range(directions):
        jobs = [(SHADOW, 0, 1)] if shadow else []
        jobs += [
            (spec['name'], f, spec['frames'])
            for spec in layers
            if d == 0 or not spec['shared']
            for f in range(spec['frames'])
        ]
        for layer, frame, frames in jobs:
            path = os.path.join(target, f'{layer}-d{d}-f{frame}.png')
            render_frame(module, bounds, size, samples, d, layer, frame, frames, path)
            count += 1
    manifest = {
        'name': name,
        'base': module.base,
        'atlas': model.get('atlas', 'entities'),
        'shadow': shadow,
        'points': {key: [project(point, d, directions) for d in range(directions)] for key, point in model.get('points', {}).items()},
        'footprint': list(model['footprint']),
        'directions': directions,
        'tilePx': scene.TILE_PX,
        'canvas': list(size),
        'anchor': list(anchor),
        'layers': layers,
    }
    with open(os.path.join(target, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f'[art] {name}: {count} frames of {size[0]}x{size[1]} in {time.time() - started:.1f} s', flush=True)


def render_ground(entry, out_dir, samples):
    """A seamless ground texture: `period`² tiles of the model's ground, through the game camera."""
    model = entry.MODEL
    period = model['period']
    size = period * scene.TILE_PX
    target = prepare_target(out_dir, model['name'])
    started = time.time()
    scene.clear()
    shapes.reset()
    scene.setup_render(size, size, max(samples, 128), denoise=False, transparent=False)
    half = period / 2
    scene.setup_camera((-half, -half, half, half))
    scene.setup_lights()
    entry.build(Context(0, 'body', 0, 1))
    bpy.context.scene.render.filepath = os.path.join(target, 'ground.png')
    bpy.ops.render.render(write_still=True)
    manifest = {
        'name': model['name'],
        'base': entry.base,
        'kind': 'ground',
        'atlas': model.get('atlas', 'terrain'),
        'period': period,
        'tilePx': scene.TILE_PX,
    }
    with open(os.path.join(target, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f'[art] {model["name"]}: ground {size}x{size} in {time.time() - started:.1f} s', flush=True)


def render_icon(entry, models, out_dir, samples):
    """An item icon: the model (or the idle body of `from`) through the game camera, framed to fit."""
    model = entry.MODEL
    target = prepare_target(out_dir, model['name'])
    started = time.time()
    scene.clear()
    source = models[model['from']] if 'from' in model else entry
    specs = layer_specs(source.MODEL)
    shapes.reset(specs[0]['name'])
    scene.setup_render(ICON_RENDER_PX, ICON_RENDER_PX, samples, stretch=False)
    scene.setup_lights()
    scene.add_ground(shadow_catcher=False)
    direction = model.get('direction', 0)
    source.build(Context(direction, specs[0]['name'], 0, 1))
    shapes.root().rotation_euler = (0.0, 0.0, -direction * math.pi / 2)
    # Only what the entity shows while idle: no fire, no working lights.
    hidden = {spec['name'] for spec in specs if spec['show'] == 'working'}
    for obj in bpy.data.objects:
        if obj.get('bw_layer') in hidden:
            obj.hide_render = True
    scene.frame_icon(model.get('margin', 0.04), model.get('tilt', 0.0))
    bpy.context.scene.render.filepath = os.path.join(target, 'icon.png')
    bpy.ops.render.render(write_still=True)
    manifest = {
        'name': model['name'],
        'item': model.get('item', model['name']),
        'base': entry.base,
        'kind': 'icon',
        'atlas': model.get('atlas', 'icons'),
        'size': ICON_RENDER_PX,
    }
    with open(os.path.join(target, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f'[art] {model["name"]}: icon in {time.time() - started:.1f} s', flush=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1 :] if '--' in sys.argv else []
    parser = argparse.ArgumentParser(prog='render.py')
    parser.add_argument('--out', required=True)
    parser.add_argument('--samples', type=int, default=96)
    parser.add_argument('names', nargs='*')
    args = parser.parse_args(argv)
    models = load_models()
    unknown = [n for n in args.names if not any(matches(n, m) for m in models.values())]
    if unknown:
        print(f'[art] unknown model(s): {", ".join(unknown)}; known: {", ".join(models)}', flush=True)
        sys.exit(2)
    picked = [n for n, m in models.items() if not args.names or any(matches(a, m) for a in args.names)]
    out = os.path.abspath(args.out)
    for name in picked:
        entry = models[name]
        kind = entry.MODEL.get('kind', 'sprite')
        if kind == 'ground':
            render_ground(entry, out, args.samples)
        elif kind == 'icon':
            render_icon(entry, models, out, args.samples)
        else:
            render_model(entry, out, args.samples)


try:
    main()
except SystemExit:
    raise
except BaseException:
    import traceback

    traceback.print_exc()
    sys.exit(1)
