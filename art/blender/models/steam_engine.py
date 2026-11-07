"""
Steam engine (3x5, 4 directions): a horizontal engine on a stone bed. The
steam cylinder sits at the front, a crosshead runs in guides behind it, and
a connecting rod turns the crankshaft at the rear, which carries a big
flywheel on one side and the generator on the other. Steam pipes with
flanges at both ends, where it connects to a boiler or the next engine
(docs/DECISIONS.md, D25). Modeled facing north.

Layers: `body`; `motion`, everything that moves: the piston rod,
crosshead, connecting rod, crank, the flywheel (with painted marks on its
rim, so it reads turning even seen edge-on) and the governor's balls on
top. One full turn over 16 frames; the game runs it at a speed
proportional to the engine's output (src/render/generatorLayer.ts), one
turn per second at full power.
"""

import math

from bwart import materials as m
from bwart.shapes import box, cylinder, layer, pipe, sphere, torus

MODEL = {
    'name': 'steam-engine',
    'atlas': 'power',
    'footprint': (3, 5),
    'height': 1.9,
    'shadow_reach': 2.2,
    'directions': 4,
    'layers': [
        {'name': 'body'},
        {'name': 'motion', 'frames': 16, 'fps': 16},
    ],
}

AXIS_X = -0.35  # the cylinder, crosshead and crank line
AXIS_Z = 0.9
CRANK_Y = -1.25
CRANK_R = 0.26
ROD_L = 1.05
CYL_Y0 = 0.62  # rear head of the cylinder
CYL_Y1 = 2.0
CYL_R = 0.36
WHEEL_X = 0.86
WHEEL_R = 0.84
GEN_X = -1.0


def build(ctx):
    paint = m.paint('steam_paint', 'steam', amount=0.12)
    frame = m.dark_iron()
    iron = m.iron()
    steel = m.worn('steel', 'steel', metallic=0.75, roughness=0.28, amount=0.08)
    brass = m.worn('brass', 'brass', metallic=0.7, roughness=0.32, amount=0.15)
    stone = m.stone('bed_stone', base=0x6a665f)
    copper = m.worn('copper_coil', 'copper', metallic=0.7, roughness=0.35, amount=0.15)

    # The stone bed, an iron frame on it, and a slot for the flywheel.
    box((2.86, 4.86, 0.14), (0, 0, 0.07), stone, bevel=0.03)
    box((0.9, 4.2, 0.3), (AXIS_X, 0.05, 0.29), frame, bevel=0.03)
    box((0.3, 2.0, 0.04), (WHEEL_X, CRANK_Y, 0.15), m.plain('pit', 0x1d1c1a, roughness=1.0), bevel=0.0)
    # Steam pipes: flanges at both ends (where boilers and engines connect),
    # joined along the east side and feeding the steam chest.
    pipe_mat = iron
    for y, s in ((2.42, 1), (-2.42, -1)):
        cylinder(0.17, 0.06, (0, y, 0.5), frame, rot=(math.pi / 2, 0, 0), verts=20, bevel=0.01)
        for k in range(6):
            a = k * math.pi / 3
            cylinder(0.02, 0.07, (math.cos(a) * 0.13, y + s * 0.01, 0.5 + math.sin(a) * 0.13), brass, rot=(math.pi / 2, 0, 0), verts=8)
    pipe([(0, 2.4, 0.5), (0, 2.25, 0.5), (0.55, 2.1, 0.5), (0.55, -2.1, 0.5), (0, -2.25, 0.5), (0, -2.4, 0.5)], 0.08, pipe_mat)
    pipe([(0.55, 1.3, 0.5), (0.25, 1.3, AXIS_Z + CYL_R + 0.12)], 0.06, pipe_mat)
    # The cylinder: lagged barrel with brass bands and end covers, on a cradle,
    # a steam chest on top, the governor's column on the chest.
    cy = (CYL_Y0 + CYL_Y1) / 2
    box((0.7, CYL_Y1 - CYL_Y0 - 0.2, AXIS_Z - 0.2), (AXIS_X, cy, 0.26 + (AXIS_Z - 0.4) / 2), frame, bevel=0.03)
    cylinder(CYL_R, CYL_Y1 - CYL_Y0, (AXIS_X, cy, AXIS_Z), paint, rot=(math.pi / 2, 0, 0), verts=36)
    for y in (CYL_Y0 + 0.05, CYL_Y1 - 0.05):
        cylinder(CYL_R + 0.04, 0.1, (AXIS_X, y, AXIS_Z), frame, rot=(math.pi / 2, 0, 0), verts=36, bevel=0.015)
    for y in (cy - 0.35, cy + 0.35):
        torus(CYL_R + 0.005, 0.025, (AXIS_X, y, AXIS_Z), brass, rot=(math.pi / 2, 0, 0), major_segments=36, minor_segments=6)
    cylinder(0.16, 0.05, (AXIS_X, CYL_Y1 + 0.02, AXIS_Z), brass, rot=(math.pi / 2, 0, 0), verts=20, bevel=0.01)
    box((0.42, 0.9, 0.26), (AXIS_X + 0.1, cy, AXIS_Z + CYL_R + 0.08), paint, bevel=0.03)
    box((0.46, 0.94, 0.04), (AXIS_X + 0.1, cy, AXIS_Z + CYL_R + 0.22), frame, bevel=0.01)
    cylinder(0.04, 0.32, (AXIS_X, cy - 0.15, AXIS_Z + CYL_R + 0.38), brass, verts=10)
    # Gland where the piston rod leaves the cylinder.
    cylinder(0.09, 0.12, (AXIS_X, CYL_Y0 - 0.06, AXIS_Z), brass, rot=(math.pi / 2, 0, 0), verts=16)
    # Crosshead guides: two bars on posts.
    g0, g1 = -0.62, CYL_Y0 - 0.1
    for sx in (-1, 1):
        box((0.05, g1 - g0, 0.06), (AXIS_X + sx * 0.14, (g0 + g1) / 2, AXIS_Z), steel, bevel=0.01)
        for y in (g0 + 0.05, g1 - 0.05):
            box((0.06, 0.08, AXIS_Z - 0.26), (AXIS_X + sx * 0.14, y, 0.26 + (AXIS_Z - 0.26) / 2), frame, bevel=0.01)
    # Main bearings carrying the crankshaft, the shaft itself.
    for x in (AXIS_X - 0.3, AXIS_X + 0.3, WHEEL_X - 0.25):
        box((0.16, 0.36, AXIS_Z - 0.2), (x, CRANK_Y, 0.26 + (AXIS_Z - 0.32) / 2), frame, bevel=0.02)
        box((0.2, 0.3, 0.12), (x, CRANK_Y, AXIS_Z), iron, bevel=0.02)
    cylinder(0.065, WHEEL_X - GEN_X + 0.2, ((WHEEL_X + GEN_X) / 2, CRANK_Y, AXIS_Z), steel, rot=(0, math.pi / 2, 0), verts=14)
    # The generator on the west side of the crank: a drum with copper windings showing through slots.
    gl = 0.5
    cylinder(0.46, gl, (GEN_X, CRANK_Y, AXIS_Z - 0.06), paint, rot=(0, math.pi / 2, 0), verts=36)
    for x in (GEN_X - gl / 2, GEN_X + gl / 2):
        cylinder(0.48, 0.06, (x, CRANK_Y, AXIS_Z - 0.06), frame, rot=(0, math.pi / 2, 0), verts=36, bevel=0.01)
    for k in range(5):
        a = math.radians(40 + k * 25)
        box((gl - 0.12, 0.08, 0.03), (GEN_X, CRANK_Y + math.cos(a) * 0.46, AXIS_Z - 0.06 + math.sin(a) * 0.46), copper, rot=(a - math.pi / 2, 0, 0), bevel=0.0)
    box((0.7, 0.9, 0.36), (GEN_X, CRANK_Y, 0.32), frame, bevel=0.03)
    # Terminal box and a cable conduit down to the bed.
    box((0.24, 0.2, 0.16), (GEN_X, CRANK_Y - 0.45, AXIS_Z + 0.1), frame, bevel=0.02)
    pipe([(GEN_X, CRANK_Y - 0.55, AXIS_Z + 0.1), (GEN_X, CRANK_Y - 0.8, 0.4), (GEN_X, -2.2, 0.2)], 0.035, m.plain('rubber', 'rubber', roughness=0.7))

    with layer('motion'):
        theta = ctx.t('motion') * 2 * math.pi
        # The crank pin goes round in the vertical plane along the engine.
        pin_y = CRANK_Y + CRANK_R * math.cos(theta)
        pin_z = AXIS_Z + CRANK_R * math.sin(theta)
        head_y = pin_y + math.sqrt(ROD_L**2 - (pin_z - AXIS_Z) ** 2)
        # Crank webs and pin.
        for sx in (-1, 1):
            box((0.05, CRANK_R + 0.2, 0.16), (AXIS_X + sx * 0.1, (CRANK_Y + pin_y) / 2, (AXIS_Z + pin_z) / 2), iron, rot=(theta, 0, 0), bevel=0.015)
        cylinder(0.045, 0.24, (AXIS_X, pin_y, pin_z), steel, rot=(0, math.pi / 2, 0), verts=12)
        # Connecting rod from the crank pin to the crosshead.
        pipe([(AXIS_X, pin_y, pin_z), (AXIS_X, head_y, AXIS_Z)], 0.045, steel)
        cylinder(0.08, 0.12, (AXIS_X, pin_y, pin_z), iron, rot=(0, math.pi / 2, 0), verts=14)
        # Crosshead block between the guides, piston rod into the gland.
        box((0.22, 0.16, 0.14), (AXIS_X, head_y, AXIS_Z), brass, bevel=0.02)
        pipe([(AXIS_X, head_y, AXIS_Z), (AXIS_X, CYL_Y0, AXIS_Z)], 0.03, steel)
        # The flywheel: rim, hub and six spokes, turning with the crank; red
        # marks on the rim's tread show the motion from above.
        for dx in (-0.035, 0.035):
            torus(WHEEL_R - 0.07, 0.07, (WHEEL_X + dx, CRANK_Y, AXIS_Z), frame, rot=(0, math.pi / 2, 0), major_segments=48, minor_segments=8)
        cylinder(0.14, 0.2, (WHEEL_X, CRANK_Y, AXIS_Z), iron, rot=(0, math.pi / 2, 0), verts=20, bevel=0.02)
        for k in range(6):
            a = theta + k * math.pi / 3
            r = (WHEEL_R - 0.1) / 2
            box((0.06, WHEEL_R - 0.16, 0.09), (WHEEL_X, CRANK_Y + math.cos(a) * r, AXIS_Z + math.sin(a) * r), iron, rot=(a, 0, 0), bevel=0.015)
        mark = m.paint('wheel_mark', 0xb8402e, amount=0.1)
        for k in range(4):
            a = theta + k * math.pi / 2 + math.pi / 4
            box((0.13, 0.2, 0.02), (WHEEL_X, CRANK_Y + math.cos(a) * WHEEL_R, AXIS_Z + math.sin(a) * WHEEL_R), mark, rot=(a - math.pi / 2, 0, 0), bevel=0.0)
        # The governor: two balls on arms, spinning round the column on the steam chest.
        gx, gy, gz = AXIS_X, (CYL_Y0 + CYL_Y1) / 2 - 0.15, AXIS_Z + CYL_R + 0.56
        spin = theta * 2
        for s in (0, math.pi):
            a = spin + s
            bx = gx + math.cos(a) * 0.16
            by = gy + math.sin(a) * 0.16
            pipe([(gx, gy, gz), (bx, by, gz - 0.1)], 0.012, steel)
            sphere(0.06, (bx, by, gz - 0.1), brass, segments=14)
        cylinder(0.03, 0.06, (gx, gy, gz + 0.02), brass, verts=10)
