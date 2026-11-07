"""
Burner mining drill (2x2, 4 directions): a firebox housing at the rear with
a chimney, a drilling gantry at the front with the drive gears on top, and
an output chute at the front-left, over the tile the drill drops onto
(docs/DECISIONS.md, D12). Modeled facing north.

Layers: `body`; `head`, the drive gears, turning while the drill works
(a third of a turn over 8 frames: the big gear has 3 spokes and 12 teeth,
the pinion 6, so both line up again where the loop starts over); `fire`,
the glow of the firebox through its vent and door, while it works.
"""

import math

from bwart import materials as m
from bwart.shapes import box, cylinder, gear, layer, pipe

MODEL = {
    'name': 'burner-mining-drill',
    'footprint': (2, 2),
    'height': 1.4,
    'directions': 4,
    'layers': [
        {'name': 'body'},
        {'name': 'fire', 'frames': 1, 'show': 'working'},
        {'name': 'head', 'frames': 8, 'fps': 12},
    ],
}

TOP = 1.0  # gantry top
HOUSING_H = 0.62


def build(ctx):
    housing = m.paint('drill_housing', 0x9a5536, amount=0.22)
    frame = m.dark_iron()
    iron = m.iron()
    brass = m.worn('brass', 'brass', metallic=0.7, roughness=0.32, amount=0.15)
    soot = m.plain('soot', 'soot', roughness=1.0)
    hazard = m.paint('hazard', 'hazard', amount=0.25)

    # Skid.
    box((1.86, 1.86, 0.1), (0, 0, 0.05), frame, bevel=0.03)
    for sx in (-1, 1):
        box((0.12, 1.9, 0.14), (sx * 0.8, 0, 0.07), frame, bevel=0.03)
    # Rear housing with the firebox: a vent on top, a door at the back.
    hy = -0.47
    box((1.64, 0.82, HOUSING_H), (0, hy, 0.1 + HOUSING_H / 2), housing, bevel=0.04)
    box((1.7, 0.88, 0.05), (0, hy, 0.1 + HOUSING_H), housing, bevel=0.02)
    zt = 0.1 + HOUSING_H + 0.03
    # Vent: a dark well with bars across it (the fire layer glows in the well).
    box((0.6, 0.36, 0.06), (-0.3, hy - 0.02, zt), soot, bevel=0.0)
    for i in range(4):
        box((0.04, 0.42, 0.05), (-0.3 - 0.21 + i * 0.14, hy - 0.02, zt + 0.02), frame, bevel=0.0)
    box((0.42, 0.04, 0.3), (0, hy - 0.42, 0.34), frame, bevel=0.015)
    for i in range(3):
        box((0.3, 0.05, 0.03), (0, hy - 0.44, 0.26 + i * 0.07), soot, bevel=0.0)
    cylinder(0.035, 0.08, (0.17, hy - 0.46, 0.34), brass, rot=(math.pi / 2, 0, 0), verts=10)
    # Chimney at the rear right.
    cylinder(0.1, 0.75, (0.56, hy - 0.12, zt + 0.37), iron, verts=16)
    cylinder(0.14, 0.06, (0.56, hy - 0.12, zt + 0.76), frame, verts=16)
    cylinder(0.08, 0.02, (0.56, hy - 0.12, zt + 0.79), soot, verts=16)
    # Gantry at the front: four posts, braces, a deck carrying the gears, and the drill shaft.
    gy = 0.46
    for sx in (-1, 1):
        for sy in (-1, 1):
            box((0.1, 0.1, TOP), (sx * 0.4, gy + sy * 0.3, TOP / 2), frame, bevel=0.02)
        pipe([(sx * 0.4, gy - 0.3, 0.2), (sx * 0.4, gy + 0.3, TOP - 0.2)], 0.025, frame)
    box((0.96, 0.76, 0.08), (0, gy, TOP), frame, bevel=0.025)
    cylinder(0.07, TOP, (0.12, gy, TOP / 2), iron, verts=12)
    cylinder(0.16, 0.12, (0.12, gy, 0.16), frame, verts=16)
    # Output chute over the front-left tile, with a hazard-striped lip.
    chute = (-0.5, 0.95, 0.24)
    box((0.4, 0.62, 0.05), (-0.5, 0.72, 0.36), frame, bevel=0.015, rot=(math.radians(-24), 0, 0))
    for sx in (-1, 1):
        box((0.04, 0.62, 0.14), (-0.5 + sx * 0.19, 0.72, 0.41), frame, bevel=0.01, rot=(math.radians(-24), 0, 0))
    box((0.42, 0.06, 0.06), chute, hazard, bevel=0.015)
    # A drive shaft from the housing to the gears.
    pipe([(-0.3, hy + 0.3, zt), (-0.3, gy - 0.25, TOP + 0.06)], 0.04, iron)

    with layer('fire'):
        glow = m.emissive('fire_glow', 0xf07020, strength=1.6)
        box((0.56, 0.32, 0.02), (-0.3, hy - 0.02, zt + 0.02), glow, bevel=0.0)
        box((0.3, 0.02, 0.22), (0, hy - 0.43, 0.33), glow, bevel=0.0)

    with layer('head'):
        turn = ctx.t('head') * (2 * math.pi / 3)
        zg = TOP + 0.1
        gear(0.36, 12, 0.07, (0.12, gy, zg), brass, phase=-turn)
        cylinder(0.09, 0.1, (0.12, gy, zg + 0.04), frame, verts=16)
        for k in range(3):
            a = -turn + k * 2 * math.pi / 3
            box((0.27, 0.06, 0.04), (0.12 + math.cos(a) * 0.15, gy + math.sin(a) * 0.15, zg + 0.05), frame, rot=(0, 0, a), bevel=0.01)
        # A pinion meshing with it, turning the other way.
        pinion_turn = turn * 2
        gear(0.18, 6, 0.07, (-0.3, gy - 0.25, zg), iron, phase=pinion_turn)
        cylinder(0.05, 0.1, (-0.3, gy - 0.25, zg + 0.03), frame, verts=12)
