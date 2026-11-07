"""
Small electric pole (1x1), in the `logistics` atlas: a wooden post on a
stone footing with iron bands, and a crossbar with a ceramic insulator at
each end. The wires (drawn by the game, src/render/powerLayer.ts) hang from
the insulators, the `wire-west` and `wire-east` points.
"""

import math

from bwart import materials as m
from bwart.shapes import box, cylinder

TOP = 1.5
BAR_Z = 1.36
INSULATOR_X = 0.25
WIRE_Z = BAR_Z + 0.14

MODEL = {
    'name': 'small-electric-pole',
    'atlas': 'logistics',
    'footprint': (1, 1),
    'height': TOP + 0.05,
    'points': {
        'wire-west': (-INSULATOR_X, 0.0, WIRE_Z),
        'wire-east': (INSULATOR_X, 0.0, WIRE_Z),
    },
    'layers': [{'name': 'body'}],
}


def build(ctx):
    wood = m.wood('pole_wood', base=0x8a6440)
    wood_dark = m.wood('pole_wood_dark', base=0x6e4c2e)
    iron = m.dark_iron()
    stone = m.stone('stone')
    ceramic = m.worn('insulator', 0xd8dcd6, wear=0xa9aca4, metallic=0.0, roughness=0.25, amount=0.1)
    copper = m.worn('copper', 'copper', metallic=0.8, roughness=0.3, amount=0.15)

    # Footing, and the post (planks run along the post: turn the grain upright).
    box((0.4, 0.4, 0.12), (0, 0, 0.06), stone, bevel=0.03)
    post = box((TOP - 0.06, 0.17, 0.17), (0, 0, 0.06 + (TOP - 0.06) / 2), wood, bevel=0.02, rot=(0, math.pi / 2, 0))
    post.name = 'post'
    for z in (0.2, 0.9):
        box((0.19, 0.19, 0.04), (0, 0, z), iron, bevel=0.008)
    # The crossbar with two braces under it.
    box((0.7, 0.11, 0.1), (0, 0, BAR_Z), wood_dark, bevel=0.02)
    for sx in (-1, 1):
        box((0.3, 0.035, 0.035), (sx * 0.12, 0, BAR_Z - 0.12), iron, bevel=0.006, rot=(0, sx * math.radians(38), 0))
    box((0.19, 0.19, 0.03), (0, 0, TOP - 0.015), iron, bevel=0.008)
    # Insulators: ribbed ceramic stacks with a copper cap where the wire is tied.
    for sx in (-1, 1):
        x = sx * INSULATOR_X
        cylinder(0.018, 0.04, (x, 0, BAR_Z + 0.05), iron, verts=10)
        for k in range(2):
            cylinder(0.06 - k * 0.01, 0.035, (x, 0, BAR_Z + 0.08 + k * 0.035), ceramic, verts=16, bevel=0.006)
        cylinder(0.03, 0.03, (x, 0, WIRE_Z - 0.005), copper, verts=12)
