"""
Lab (3x3): a pale, clean-painted research station on a dark plinth, with
corner sample racks of science vials and a round instrument well on top. In
the well sits a glass orb, dark while idle; the `glow` layer (shown while
the lab researches) lights it up in cyan, and the `ring` layer is a gimbal
of three probes that turns around the orb while it works.
"""

import math

from bwart import materials as m
from bwart.shapes import box, cylinder, layer, prism, sphere, torus

BODY_H = 0.5
ORB_Z = BODY_H + 0.42
ORB_R = 0.3

MODEL = {
    'name': 'lab',
    'footprint': (3, 3),
    'height': 1.3,
    'layers': [
        {'name': 'body'},
        {'name': 'glow', 'show': 'working', 'advance': 'never'},
        {'name': 'ring', 'frames': 16, 'fps': 12},
    ],
}


def octagon(size, cut):
    h = size / 2
    return [(-h + cut, -h), (h - cut, -h), (h, -h + cut), (h, h - cut), (h - cut, h), (-h + cut, h), (-h, h - cut), (-h, -h + cut)]


def build(ctx):
    paint = m.paint('lab', 0xb9c2ca, amount=0.02)
    accent = m.paint('lab_accent', 0x2f6f9a, amount=0.08)
    frame = m.dark_iron()
    steel = m.worn('steel', 'steel', metallic=0.7, roughness=0.3, amount=0.1)
    well = m.plain('lab_well', 0x15181c, roughness=0.8)
    glass = m.plain('lab_glass', 0x1f3442, metallic=0.0, roughness=0.12)
    red = m.emissive('vial_red', 0xd23c3c, strength=0.9)
    green = m.emissive('vial_green', 0x3cb44a, strength=0.9)

    # Plinth, body and a blue band.
    prism(octagon(2.94, 0.34), 0.12, (0, 0, 0), frame, bevel=0.03)
    prism(octagon(2.7, 0.4), BODY_H - 0.12, (0, 0, 0.12), paint, bevel=0.04)
    prism(octagon(2.74, 0.41), 0.12, (0, 0, BODY_H - 0.22), accent, bevel=0.02)
    # Front: a dark console window with a strip of indicator lights.
    box((1.0, 0.03, 0.16), (0, -1.35, 0.3), well, bevel=0.0)
    for i, mat in enumerate((red, green, red, green)):
        box((0.08, 0.02, 0.05), (-0.3 + i * 0.2, -1.365, 0.3), mat, bevel=0.0)

    # Corner racks: a small stand with two vials (red and green) each.
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * 1.0, sy * 1.0
            cylinder(0.2, 0.08, (x, y, BODY_H + 0.04), frame, verts=20, bevel=0.015)
            for k, mat in enumerate((red, green)):
                dx = (k - 0.5) * 0.16
                cylinder(0.055, 0.26, (x + dx, y, BODY_H + 0.21), mat, verts=12)
                cylinder(0.06, 0.04, (x + dx, y, BODY_H + 0.36), steel, verts=12)

    # The instrument well: a collar and the dark glass orb on a pedestal.
    zt = BODY_H
    cylinder(0.78, 0.1, (0, 0, zt + 0.05), frame, verts=48, bevel=0.02)
    cylinder(0.7, 0.02, (0, 0, zt + 0.1), well, verts=48)
    cylinder(0.16, 0.14, (0, 0, zt + 0.17), steel, verts=24, bevel=0.02)
    sphere(ORB_R, (0, 0, ORB_Z), glass, segments=24)

    with layer('glow'):
        sphere(ORB_R + 0.01, (0, 0, ORB_Z), m.emissive('lab_glow', 0x7fd4ff, strength=1.1), segments=24)

    with layer('ring'):
        # Three probes 120 degrees apart: a cycle turns the gimbal by one spacing.
        turn = ctx.t('ring') * 2 * math.pi / 3
        torus(0.5, 0.025, (0, 0, ORB_Z - 0.05), steel, major_segments=48, minor_segments=8)
        for k in range(3):
            a = turn + k * 2 * math.pi / 3
            cx, cy = math.cos(a), math.sin(a)
            box((0.06, 0.06, 0.28), (cx * 0.5, cy * 0.5, ORB_Z + 0.06), accent, bevel=0.015)
            sphere(0.06, (cx * 0.5, cy * 0.5, ORB_Z + 0.22), steel, segments=12)
