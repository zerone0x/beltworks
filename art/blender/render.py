"""
Renders the sprite models under art/blender/models/ to PNG frames.

    blender -b --factory-startup -P art/blender/render.py -- --out art/build [--samples 96] [name ...]

`npm run art` runs this (through $BLENDER) and then packs the frames into
atlases with tools/art/pack.mjs; see docs/ART.md.

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


class Context:
    """What a model's `build` gets: the direction, and the animation phase of the layer being rendered."""

    def __init__(self, direction, layer, frame, frames):
        self.direction = direction
        self.layer = layer
        self.frame = frame
        self.frames = frames

    def t(self, layer):
        """Animation phase (0..1, exclusive) of `layer` in this frame; 0 unless it is the one rendered."""
        if layer != self.layer or self.frames <= 1:
            return 0.0
        return self.frame / self.frames

    def frame_of(self, layer):
        return self.frame if layer == self.layer else 0


def load_models():
    models = {}
    for file in sorted(os.listdir(MODELS_DIR)):
        if not file.endswith('.py') or file.startswith('_'):
            continue
        spec = importlib.util.spec_from_file_location('bw_model_' + file[:-3], os.path.join(MODELS_DIR, file))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        models[module.MODEL['name']] = module
    return models


def layer_specs(model):
    specs = []
    for spec in model['layers']:
        specs.append(
            {
                'name': spec['name'],
                'frames': spec.get('frames', 1),
                'fps': spec.get('fps', 0),
                # When the layer is drawn: 'always', or only while the entity is 'working' / 'idle'.
                'show': spec.get('show', 'always'),
                # Whether the animation advances only while working, or all the time.
                'advance': spec.get('advance', 'working'),
            }
        )
    return specs


def render_frame(module, bounds, size, samples, direction, layer, frame, frames, path):
    scene.clear()
    shapes.reset()
    scene.setup_render(size[0], size[1], samples)
    scene.setup_camera(bounds)
    scene.setup_lights()
    scene.add_ground(shadow_catcher=layer == SHADOW)
    module.build(Context(direction, layer, frame, frames))
    root = shapes.root()
    root.rotation_euler = (0.0, 0.0, -direction * math.pi / 2)
    order = [spec['name'] for spec in layer_specs(module.MODEL)]
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
        elif index < current:
            obj.is_holdout = True
        elif index > current:
            obj.hide_render = True
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def project(point, direction):
    """Where model point (x, y, z) shows, in texels from the footprint's center, for `direction`."""
    x, y, z = point
    a = -direction * math.pi / 2
    rx = x * math.cos(a) - y * math.sin(a)
    ry = x * math.sin(a) + y * math.cos(a)
    return [round(rx * scene.TILE_PX, 2), round((-ry - z * scene.HEIGHT_ON_SCREEN) * scene.TILE_PX, 2)]


def render_model(module, out_dir, samples):
    model = module.MODEL
    name = model['name']
    bounds = scene.screen_bounds(tuple(model['footprint']), model['height'])
    size = (
        round((bounds[2] - bounds[0]) * scene.TILE_PX),
        round((bounds[3] - bounds[1]) * scene.TILE_PX),
    )
    anchor = (round(-bounds[0] * scene.TILE_PX), round(-bounds[1] * scene.TILE_PX))
    target = os.path.join(out_dir, name)
    os.makedirs(target, exist_ok=True)
    for file in os.listdir(target):
        os.remove(os.path.join(target, file))
    layers = layer_specs(model)
    directions = model.get('directions', 1)
    started = time.time()
    count = 0
    for d in range(directions):
        jobs = [(SHADOW, 0, 1)] + [(spec['name'], f, spec['frames']) for spec in layers for f in range(spec['frames'])]
        for layer, frame, frames in jobs:
            path = os.path.join(target, f'{layer}-d{d}-f{frame}.png')
            render_frame(module, bounds, size, samples, d, layer, frame, frames, path)
            count += 1
    manifest = {
        'name': name,
        'points': {key: [project(point, d) for d in range(directions)] for key, point in model.get('points', {}).items()},
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


def main():
    argv = sys.argv[sys.argv.index('--') + 1 :] if '--' in sys.argv else []
    parser = argparse.ArgumentParser(prog='render.py')
    parser.add_argument('--out', required=True)
    parser.add_argument('--samples', type=int, default=96)
    parser.add_argument('names', nargs='*')
    args = parser.parse_args(argv)
    models = load_models()
    unknown = [n for n in args.names if n not in models]
    if unknown:
        print(f'[art] unknown model(s): {", ".join(unknown)}; known: {", ".join(models)}', flush=True)
        sys.exit(2)
    for name in args.names or list(models):
        render_model(models[name], os.path.abspath(args.out), args.samples)


try:
    main()
except SystemExit:
    raise
except BaseException:
    import traceback

    traceback.print_exc()
    sys.exit(1)
