"""Wooden chest (1x1): a plank chest with an arched lid, iron corner brackets and straps."""

import math

from bwart import materials as m
from bwart.shapes import box, cylinder

MODEL = {
    'name': 'wooden-chest',
    'footprint': (1, 1),
    'height': 0.8,
    'layers': [{'name': 'body'}],
}

W, D, H = 0.84, 0.64, 0.44  # body
ARCH = 0.2  # lid rise above the body


def lid_shape(radius, length, x, mat):
    """A half-round lid section along X, flattened to ARCH tall."""
    obj = cylinder(radius, length, (x, 0.0, H), mat, rot=(0.0, math.pi / 2, 0.0), verts=28)
    obj.scale = (ARCH / radius, 1.0, 1.0)
    return obj


def build(ctx):
    plank = m.wood('plank')
    plank_dark = m.wood('plank_dark', base=0x84592f)
    core = m.plain('crate_core', 0x2a1c10, roughness=0.9)
    iron = m.dark_iron()
    latch = m.worn('latch', 'brass', metallic=0.6, roughness=0.35, amount=0.15)

    box((W - 0.04, D - 0.04, H), (0, 0, H / 2), core, bevel=0.0)
    # Three planks per side, with dark gaps between them.
    rows = 3
    gap = 0.016
    ph = (H - gap * (rows - 1)) / rows
    for i in range(rows):
        z = ph / 2 + i * (ph + gap)
        mat = plank if i % 2 == 0 else plank_dark
        box((W, 0.05, ph), (0, -D / 2 + 0.025, z), mat, bevel=0.012)
        box((W, 0.05, ph), (0, D / 2 - 0.025, z), mat, bevel=0.012)
        box((0.05, D - 0.06, ph), (-W / 2 + 0.025, 0, z), mat, bevel=0.012)
        box((0.05, D - 0.06, ph), (W / 2 - 0.025, 0, z), mat, bevel=0.012)
    # Arched lid with a slight overhang, iron bands over it at both ends and the middle.
    r = D / 2 + 0.03
    lid_shape(r, W + 0.04, 0.0, plank)
    for x in (-W / 2 + 0.06, 0.0, W / 2 - 0.06):
        lid_shape(r + 0.012, 0.06, x, iron)
    # Corner brackets, a lip under the lid, and a latch at the front.
    for sx in (-1, 1):
        for sy in (-1, 1):
            box((0.09, 0.09, H), (sx * (W / 2 - 0.03), sy * (D / 2 - 0.03), H / 2), iron, bevel=0.015)
    box((W + 0.03, D + 0.03, 0.04), (0, 0, H - 0.01), iron, bevel=0.01)
    box((0.12, 0.05, 0.15), (0, -D / 2 - 0.03, H - 0.02), latch, bevel=0.015)
