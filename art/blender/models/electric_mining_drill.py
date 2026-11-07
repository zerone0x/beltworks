"""
Electric mining drill (3x3, 4 directions): a steel-blue housing on a skid,
the motor cabinet with cooling fins at the rear, the drill's gear turret in
the middle, and an output chute over the middle of the front edge, where it
drops what it mines. Modeled facing north.

Layers: `body`; `head`, the turret's gear ring and drive arms, turning while
the drill works (a third of a turn over 12 frames: three arms, 24 teeth, so
it lines up again where the loop starts over); `lights`, a green lamp on
the cabinet, while it works.
"""

import math

from bwart import materials as m
from bwart.shapes import box, cylinder, gear, layer, pipe, prism, sphere

MODEL = {
    'name': 'electric-mining-drill',
    'atlas': 'power',
    'footprint': (3, 3),
    'height': 1.2,
    'directions': 4,
    'layers': [
        {'name': 'body'},
        {'name': 'head', 'frames': 12, 'fps': 18},
        {'name': 'lights', 'show': 'working'},
    ],
}

HOUSING_H = 0.56
TURRET = (0.0, 0.18)


def chamfered(w, h, cut):
    x, y = w / 2, h / 2
    return [(-x + cut, -y), (x - cut, -y), (x, -y + cut), (x, y - cut), (x - cut, y), (-x + cut, y), (-x, y - cut), (-x, -y + cut)]


def build(ctx):
    paint = m.paint('electric_paint', 'electric', amount=0.1)
    trim = m.paint('electric_trim', 0x34383e, amount=0.1)
    frame = m.dark_iron()
    iron = m.iron()
    steel = m.worn('steel', 'steel', metallic=0.75, roughness=0.28, amount=0.08)
    hazard = m.paint('hazard', 'hazard', amount=0.2)
    soot = m.plain('well', 0x17181a, roughness=0.9)

    # Skid with feet at the corners.
    prism(chamfered(2.9, 2.9, 0.25), 0.1, (0, 0, 0), frame, bevel=0.03)
    for sx in (-1, 1):
        for sy in (-1, 1):
            box((0.34, 0.34, 0.16), (sx * 1.18, sy * 1.18, 0.08), frame, bevel=0.03)
    # The housing: a chamfered block with a darker band at the bottom.
    prism(chamfered(2.56, 2.5, 0.34), HOUSING_H - 0.1, (0, -0.05, 0.1), paint, bevel=0.04)
    prism(chamfered(2.62, 2.56, 0.36), 0.08, (0, -0.05, 0.1), trim, bevel=0.02)
    # The motor cabinet at the rear, with fins and a cable gland.
    cab_y = -0.78
    box((1.9, 0.72, 0.42), (0, cab_y, HOUSING_H + 0.2), paint, bevel=0.04)
    box((1.96, 0.78, 0.04), (0, cab_y, HOUSING_H + 0.42), trim, bevel=0.015)
    for k in range(9):
        box((0.035, 0.6, 0.06), (-0.72 + k * 0.18, cab_y, HOUSING_H + 0.45), frame, bevel=0.0)
    for k in range(5):
        box((1.5, 0.03, 0.05), (0, cab_y - 0.37, HOUSING_H + 0.08 + k * 0.07), frame, bevel=0.0)
    box((0.22, 0.12, 0.16), (0.98, cab_y - 0.2, HOUSING_H + 0.12), frame, bevel=0.02)
    pipe([(1.0, cab_y - 0.26, HOUSING_H + 0.12), (1.22, cab_y - 0.5, 0.2), (1.22, -1.4, 0.12)], 0.035, m.plain('rubber', 'rubber', roughness=0.7))
    # Lamp housing on the cabinet (the lights layer glows in it).
    cylinder(0.08, 0.06, (-0.75, cab_y + 0.18, HOUSING_H + 0.46), frame, verts=16)
    sphere(0.055, (-0.75, cab_y + 0.18, HOUSING_H + 0.5), m.plain('lamp_off', 0x2d4a32, roughness=0.3), segments=12)
    # The turret: a round collar on the housing, a dark well, the drill shaft in it.
    tx, ty = TURRET
    zt = HOUSING_H
    cylinder(0.62, 0.12, (tx, ty, zt + 0.06), trim, verts=40, bevel=0.02)
    cylinder(0.5, 0.04, (tx, ty, zt + 0.12), soot, verts=40)
    cylinder(0.16, 0.36, (tx, ty, zt + 0.22), steel, verts=20)
    # Front: the output chute over the middle of the front edge, with a hazard lip.
    box((0.62, 0.5, 0.05), (0, 1.2, 0.36), frame, bevel=0.015, rot=(math.radians(-18), 0, 0))
    for sx in (-1, 1):
        box((0.05, 0.5, 0.16), (sx * 0.3, 1.2, 0.41), frame, bevel=0.01, rot=(math.radians(-18), 0, 0))
    box((0.64, 0.06, 0.06), (0, 1.45, 0.29), hazard, bevel=0.015)
    # Hazard stripes along the front of the housing, a vent grille either side.
    box((2.0, 0.05, 0.06), (0, 1.21, HOUSING_H - 0.02), hazard, bevel=0.01)
    for sx in (-1, 1):
        for k in range(4):
            box((0.4, 0.03, 0.04), (sx * 0.8, 1.21, 0.24 + k * 0.07), frame, bevel=0.0)

    with layer('head'):
        turn = ctx.t('head') * (2 * math.pi / 3)
        zg = zt + 0.2
        gear(0.48, 24, 0.08, (tx, ty, zg), m.worn('brass', 'brass', metallic=0.7, roughness=0.32, amount=0.15), phase=-turn, tooth=0.12)
        cylinder(0.2, 0.14, (tx, ty, zg + 0.06), iron, verts=24, bevel=0.02)
        for k in range(3):
            a = -turn + k * 2 * math.pi / 3
            box((0.36, 0.09, 0.07), (tx + math.cos(a) * 0.26, ty + math.sin(a) * 0.26, zg + 0.07), frame, rot=(0, 0, a), bevel=0.015)
            cylinder(0.05, 0.08, (tx + math.cos(a) * 0.4, ty + math.sin(a) * 0.4, zg + 0.09), steel, verts=12)
        cylinder(0.07, 0.06, (tx, ty, zg + 0.15), hazard, verts=16)

    with layer('lights'):
        sphere(0.056, (-0.75, cab_y + 0.18, HOUSING_H + 0.5), m.emissive('lamp_green', 0x60ff70, strength=1.4), segments=12)
