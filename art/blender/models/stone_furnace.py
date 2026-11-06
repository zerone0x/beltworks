"""
Stone furnace (2x2): a squat tower of rough stone blocks with an arched
firebox opening at the front and a smoke hole on top, bound by an iron rim.
The `fire` layer (shown while the furnace works) is the fire seen through
the opening and the glow in the smoke hole, flickering over 4 frames.
"""

import math
import random

from bwart import materials as m
from bwart.shapes import box, cylinder, layer, sphere, torus

MODEL = {
    'name': 'stone-furnace',
    'footprint': (2, 2),
    'height': 1.0,
    'layers': [
        {'name': 'body'},
        {'name': 'fire', 'frames': 4, 'fps': 8, 'show': 'working', 'advance': 'always'},
    ],
}

COURSES = 4
COURSE_H = 0.19
BASE = 1.76  # width of the lowest course
TOP = 1.36  # width of the highest course
OPENING = 0.64  # firebox opening width
OPENING_COURSES = 2
HOLE_Y = 0.06


def course_width(k):
    return BASE + (TOP - BASE) * k / (COURSES - 1)


def build(ctx):
    rng = random.Random(7)
    stones = [
        m.stone('stone'),
        m.stone('stone_light', base=0xa89d88),
        m.stone('stone_warm', base=0x8e8070),
    ]
    mortar = m.plain('mortar', 0x3a342d, roughness=1.0)
    soot = m.plain('soot', 'soot', roughness=1.0)
    rim = m.dark_iron()

    for k in range(COURSES):
        w = course_width(k)
        z = k * COURSE_H
        # Mortar core, then rough blocks around the four sides.
        if k < OPENING_COURSES:
            # Around the firebox: the sides and the back, leaving a channel at the front.
            back = -BASE / 2 + 0.68
            box((w - 0.1, w / 2 - 0.05 - back, COURSE_H), (0, (back + w / 2 - 0.05) / 2, z + COURSE_H / 2), mortar, bevel=0.0)
            side_w = (w - 0.1 - OPENING - 0.16) / 2
            for sx in (-1, 1):
                x = sx * (OPENING / 2 + 0.08 + side_w / 2)
                box((side_w, back + w / 2 - 0.05, COURSE_H), (x, (back - w / 2 + 0.05) / 2, z + COURSE_H / 2), mortar, bevel=0.0)
        else:
            box((w - 0.1, w - 0.1, COURSE_H), (0, 0, z + COURSE_H / 2), mortar, bevel=0.0)
        for side in range(4):
            along = w - 0.02
            count = 3 if k % 2 == 0 else 4
            size = along / count
            for i in range(count):
                c = -along / 2 + size * (i + 0.5)
                if side == 0 and k < OPENING_COURSES and abs(c) < OPENING / 2 + size * 0.3:
                    continue  # the firebox opening
                jitter = rng.uniform(-0.015, 0.015)
                depth = 0.16 + rng.uniform(0.0, 0.04)
                sx = size - 0.02 + jitter
                sz = COURSE_H - 0.018 + rng.uniform(-0.01, 0.0)
                mat = stones[rng.randrange(len(stones))]
                tilt = rng.uniform(-0.04, 0.04)
                # side 0 is the front (south), then east, north, west.
                angle = side * math.pi / 2
                ox = math.sin(angle) * (w / 2 - depth / 2 + 0.01)
                oy = -math.cos(angle) * (w / 2 - depth / 2 + 0.01)
                px = ox + math.cos(angle) * c
                py = oy + math.sin(angle) * c
                box((sx, depth, sz), (px, py, z + COURSE_H / 2), mat, bevel=0.035, rot=(tilt, 0.0, angle))
    # The opening: a soot-black firebox behind it, a stone lintel over it, a hearth stone below.
    front = -course_width(0) / 2
    box((OPENING + 0.1, 0.12, OPENING_COURSES * COURSE_H), (0, front + 0.62, OPENING_COURSES * COURSE_H / 2), soot, bevel=0.0)
    for sx in (-1, 1):
        box((0.06, 0.6, OPENING_COURSES * COURSE_H), (sx * (OPENING / 2 + 0.05), front + 0.32, OPENING_COURSES * COURSE_H / 2), soot, bevel=0.0)
    box((OPENING + 0.1, 0.6, 0.04), (0, front + 0.32, OPENING_COURSES * COURSE_H + 0.02), soot, bevel=0.0)
    box((OPENING + 0.1, 0.7, 0.02), (0, front + 0.3, 0.01), m.plain('ash', 0x2c2826, roughness=1.0), bevel=0.0)
    box((OPENING + 0.36, 0.2, 0.12), (0, -course_width(1) / 2 + 0.07, OPENING_COURSES * COURSE_H + 0.03), m.stone('lintel', base=0x7d7262), bevel=0.03)
    box((OPENING + 0.2, 0.16, 0.05), (0, front - 0.04, 0.025), stones[0], bevel=0.02)
    # An iron rim around the top, a darker cap of slabs, and the smoke hole: an iron collar around a sooty flue.
    top_w = course_width(COURSES - 1)
    zt = COURSES * COURSE_H
    box((top_w + 0.06, top_w + 0.06, 0.08), (0, 0, zt + 0.02), rim, bevel=0.02)
    box((top_w - 0.1, top_w - 0.1, 0.05), (0, 0, zt + 0.05), m.stone('cap', base=0x7a7062), bevel=0.03)
    torus(0.3, 0.05, (0, HOLE_Y, zt + 0.09), rim)
    cylinder(0.26, 0.5, (0, HOLE_Y, zt - 0.17), soot, verts=28)

    with layer('fire'):
        # Flickering: each frame scales the flames differently.
        t = ctx.frame_of('fire')
        flicker = [(1.0, 0.8, 0.9), (0.85, 1.0, 0.75), (0.95, 0.75, 1.0), (0.8, 0.95, 0.85)][t]
        hot = m.emissive('fire_hot', 0xffd070, strength=1.1)
        warm = m.emissive('fire_warm', 0xf07020, strength=0.85)
        embers = m.emissive('embers', 0xa02a0c, strength=0.7)
        front = -course_width(0) / 2
        box((OPENING, 0.5, 0.06), (0, front + 0.32, 0.03), embers, bevel=0.0)
        for i, x in enumerate((-0.15, 0.0, 0.15)):
            s = flicker[i]
            sphere(0.11, (x, front + 0.38, 0.08 + 0.08 * s), warm, scale=(0.9, 0.8, 1.5 * s))
            sphere(0.065, (x, front + 0.3, 0.07 + 0.06 * s), hot, scale=(0.9, 0.8, 1.3 * s))
        # The glow in the smoke hole.
        cylinder(0.25, 0.02, (0, HOLE_Y, zt + 0.085), embers, verts=28)
        cylinder(0.16, 0.02, (0, HOLE_Y, zt + 0.09), warm, verts=28)
        cylinder(0.08 + 0.03 * flicker[1], 0.02, (0, HOLE_Y, zt + 0.095), hot, verts=20)
