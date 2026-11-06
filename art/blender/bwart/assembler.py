"""
The assembling machine family (3x3): a chamfered body on a plinth with
corner pillars, a round work well on top, and a manipulator rotor in it
(the animated `rotor` layer). Tiers differ in paint, height, rotor arms and
rooftop details. The game draws the recipe's product icon over the hub (the
`icon` point).
"""

import math

from bwart import materials as m
from bwart.shapes import box, cylinder, layer, pipe, prism

DECK_R = 0.74


def chamfered(size, cut):
    h = size / 2
    return [(-h + cut, -h), (h - cut, -h), (h, -h + cut), (h, h - cut), (h - cut, h), (-h + cut, h), (-h, h - cut), (-h, -h + cut)]


def icon_height(body_h):
    return body_h + 0.2


def build(ctx, paint_color, body_h, arms, tier):
    paint = m.paint(f'machine_{tier}', paint_color, amount=0.08)
    trim = m.paint(f'machine_{tier}_trim', 0x3b3f44, amount=0.1)
    frame = m.dark_iron()
    soot = m.plain('well', 0x17181a, roughness=0.9)
    steel = m.worn('steel', 'steel', metallic=0.7, roughness=0.3, amount=0.1)
    hazard = m.paint('hazard', 'hazard', amount=0.2)

    prism(chamfered(2.94, 0.3), 0.12, (0, 0, 0), frame, bevel=0.03)
    prism(chamfered(2.66, 0.36), body_h - 0.12, (0, 0, 0.12), paint, bevel=0.04)
    prism(chamfered(2.72, 0.38), 0.07, (0, 0, 0.12), trim, bevel=0.02)
    # A raised roof panel, a shade lighter, so the tier color reads from above.
    prism(chamfered(2.2, 0.3), 0.04, (0, 0, body_h - 0.01), paint, bevel=0.02)
    # Front: a louvred vent panel and a hazard strip along the plinth.
    for i in range(6):
        box((0.06, 0.04, body_h * 0.42), (-0.4 + i * 0.16, -1.33, 0.12 + body_h * 0.42), trim, bevel=0.01)
    box((1.1, 0.03, body_h * 0.55), (0, -1.315, 0.12 + body_h * 0.42), soot, bevel=0.0)
    box((2.0, 0.05, 0.05), (0, -1.45, 0.09), hazard, bevel=0.01)
    # Corner pillars.
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * 1.16, sy * 1.16
            cylinder(0.15, body_h + 0.1, (x, y, (body_h + 0.1) / 2), frame, verts=16, bevel=0.02)
            cylinder(0.17, 0.06, (x, y, body_h + 0.1), trim, verts=16, bevel=0.015)
    # The work well: a raised collar around a dark recess.
    zt = body_h + 0.03
    cylinder(DECK_R + 0.08, 0.1, (0, 0, zt + 0.05), frame, verts=48, bevel=0.02)
    cylinder(DECK_R, 0.02, (0, 0, zt + 0.1), soot, verts=48)
    # Rooftop details, different per tier, kept to the back half so the well stays clear.
    if tier == 1:
        box((0.5, 0.36, 0.26), (-0.82, 0.86, zt + 0.13), trim, bevel=0.03, rot=(0, 0, math.radians(45)))
        pipe([(0.85, 0.9, zt), (0.85, 0.9, zt + 0.36), (0.55, 1.1, zt + 0.36)], 0.06, steel)
    else:
        for x in (-0.86, 0.86):
            cylinder(0.12, 0.5, (x, 0.88, zt + 0.25), steel, verts=16)
            cylinder(0.15, 0.05, (x, 0.88, zt + 0.5), frame, verts=16)
            cylinder(0.09, 0.02, (x, 0.88, zt + 0.52), soot, verts=16)
        for sx in (-1, 1):
            for sy in (-1, 1):
                cylinder(0.06, 0.04, (sx * 1.16, sy * 1.16, body_h + 0.14), m.emissive('lamp', 0x7fd0ff, strength=1.2), verts=12)

    with layer('rotor'):
        # A whole cycle turns the rotor by one arm's spacing, so the loop is seamless.
        turn = ctx.t('rotor') * 2 * math.pi / arms
        zr = zt + 0.16
        cylinder(0.2, 0.14, (0, 0, zr), trim, verts=24, bevel=0.02)
        for k in range(arms):
            a = turn + k * 2 * math.pi / arms + math.pi / 2
            cx, cy = math.cos(a), math.sin(a)
            box((0.5, 0.1, 0.07), (cx * 0.38, cy * 0.38, zr), steel, rot=(0, 0, a), bevel=0.02)
            box((0.14, 0.2, 0.12), (cx * 0.62, cy * 0.62, zr - 0.01), hazard if tier == 1 else paint, rot=(0, 0, a), bevel=0.025)
