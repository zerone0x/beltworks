"""
Boiler (2x3, 4 directions): a riveted steam drum lying along the boiler on a
brick firebox, with a chimney at the rear and the steam outlet at the front,
the edge it faces, where the steam engines connect (docs/DECISIONS.md, D25).
Modeled facing north.

Layers: `body`; `fire` (while it works), the fire through the firebox door
at the rear, the glow of the vents along its sides and of the embers in the
chimney (seen from every direction), flickering over 4 frames.
"""

import math

from bwart import materials as m
from bwart.shapes import box, cylinder, layer, pipe, sphere, torus

MODEL = {
    'name': 'boiler',
    'atlas': 'power',
    'footprint': (2, 3),
    'height': 1.9,
    'shadow_reach': 2.2,
    'directions': 4,
    'layers': [
        {'name': 'body'},
        {'name': 'fire', 'frames': 4, 'fps': 8, 'show': 'working', 'advance': 'always'},
    ],
}

DRUM_R = 0.5
DRUM_Z = 0.86
DRUM_Y0 = -1.22  # rear end
DRUM_Y1 = 1.12  # front end
FIREBOX_H = 0.5
FIREBOX_Y0 = -1.42
FIREBOX_Y1 = -0.05
CHIMNEY = (0.52, -1.12)
CHIMNEY_TOP = 1.86


def build(ctx):
    drum = m.paint('steam_paint', 'steam', amount=0.12)
    frame = m.dark_iron()
    iron = m.iron()
    brass = m.worn('brass', 'brass', metallic=0.7, roughness=0.32, amount=0.15)
    brick = m.stone('brick', base='brick')
    soot = m.plain('soot', 'soot', roughness=1.0)

    # Skid and the firebox: a block of brick under the rear half, bound by iron corners.
    box((1.9, 2.9, 0.08), (0, 0, 0.04), frame, bevel=0.02)
    fy = (FIREBOX_Y0 + FIREBOX_Y1) / 2
    fl = FIREBOX_Y1 - FIREBOX_Y0
    box((1.5, fl, FIREBOX_H), (0, fy, 0.08 + FIREBOX_H / 2), brick, bevel=0.03)
    for i in range(3):
        # Mortar courses.
        box((1.52, fl + 0.02, 0.012), (0, fy, 0.08 + (i + 1) * FIREBOX_H / 4), m.plain('mortar', 0x3a342d, roughness=1.0), bevel=0.0)
    for sx in (-1, 1):
        for sy in (FIREBOX_Y0, FIREBOX_Y1):
            py = sy + 0.04 if sy == FIREBOX_Y0 else sy - 0.04
            box((0.1, 0.1, FIREBOX_H + 0.04), (sx * 0.74, py, 0.1 + FIREBOX_H / 2), frame, bevel=0.015)
        # Vents along the sides (the fire layer glows in them).
        box((0.04, 0.7, 0.1), (sx * 0.755, fy, 0.3), soot, bevel=0.0)
        for k in range(4):
            box((0.05, 0.03, 0.12), (sx * 0.77, fy - 0.27 + k * 0.18, 0.3), frame, bevel=0.0)
    # The firebox door at the rear: an iron frame around a dark opening with a grate.
    door_y = FIREBOX_Y0 - 0.01
    box((0.66, 0.06, 0.38), (0, door_y, 0.32), frame, bevel=0.02)
    box((0.48, 0.07, 0.24), (0, door_y - 0.005, 0.32), soot, bevel=0.0)
    for k in range(5):
        box((0.025, 0.08, 0.24), (-0.2 + k * 0.1, door_y - 0.01, 0.32), iron, bevel=0.0)
    # Saddles at the front carry the drum.
    for y in (0.35, 0.9):
        box((1.1, 0.16, DRUM_Z - 0.2), (0, y, 0.08 + (DRUM_Z - 0.2) / 2), frame, bevel=0.02)
    # The drum: a long cylinder with domed ends, three brass bands and a row of rivets.
    length = DRUM_Y1 - DRUM_Y0
    cy = (DRUM_Y0 + DRUM_Y1) / 2
    cylinder(DRUM_R, length, (0, cy, DRUM_Z), drum, rot=(math.pi / 2, 0, 0), verts=40, bevel=0.0)
    for y, s in ((DRUM_Y0, -1), (DRUM_Y1, 1)):
        sphere(DRUM_R, (0, y, DRUM_Z), m.dark_iron(), segments=32, scale=(1.0, 0.32, 1.0))
        torus(DRUM_R, 0.03, (0, y - s * 0.01, DRUM_Z), frame, rot=(math.pi / 2, 0, 0), major_segments=40)
    for y in (-0.75, 0.0, 0.7):
        torus(DRUM_R + 0.005, 0.03, (0, y, DRUM_Z), brass, rot=(math.pi / 2, 0, 0), major_segments=40, minor_segments=6)
    # Steam dome and safety valve on top, a pressure gauge on a stalk.
    cylinder(0.2, 0.26, (0, 0.45, DRUM_Z + DRUM_R + 0.06), drum, verts=24, bevel=0.02)
    cylinder(0.23, 0.05, (0, 0.45, DRUM_Z + DRUM_R + 0.2), brass, verts=24, bevel=0.01)
    cylinder(0.06, 0.2, (-0.22, -0.2, DRUM_Z + DRUM_R + 0.06), brass, verts=12)
    sphere(0.07, (-0.22, -0.2, DRUM_Z + DRUM_R + 0.18), brass, segments=12)
    pipe([(0.3, 0.75, DRUM_Z + 0.3), (0.42, 0.75, DRUM_Z + 0.55)], 0.02, iron)
    cylinder(0.1, 0.04, (0.42, 0.75, DRUM_Z + 0.6), brass, rot=(math.radians(-30), 0, 0), verts=16)
    cylinder(0.075, 0.045, (0.42, 0.748, DRUM_Z + 0.6), m.plain('gauge', 0xe8e0c8, roughness=0.4), rot=(math.radians(-30), 0, 0), verts=16)
    # Steam outlet at the front edge: a pipe from the front dome to a flange on the edge.
    out_z = 0.5
    pipe([(0, DRUM_Y1 + 0.1, DRUM_Z - 0.1), (0, 1.3, DRUM_Z - 0.1), (0, 1.3, out_z), (0, 1.42, out_z)], 0.09, iron)
    cylinder(0.17, 0.06, (0, 1.44, out_z), frame, rot=(math.pi / 2, 0, 0), verts=20, bevel=0.01)
    for k in range(6):
        a = k * math.pi / 3
        cylinder(0.02, 0.07, (math.cos(a) * 0.13, 1.45, out_z + math.sin(a) * 0.13), brass, rot=(math.pi / 2, 0, 0), verts=8)
    # Feed water pipe along the west side.
    pipe([(-0.62, 1.2, 0.2), (-0.62, 0.0, 0.2), (-0.45, -0.3, DRUM_Z - 0.2)], 0.035, m.worn('copper_pipe', 'copper', metallic=0.7, roughness=0.35, amount=0.2))
    # Chimney at the rear right, from the firebox up past the drum, with a cap.
    cx, cy2 = CHIMNEY
    cylinder(0.14, CHIMNEY_TOP - 0.5, (cx, cy2, 0.5 + (CHIMNEY_TOP - 0.5) / 2), iron, verts=20)
    cylinder(0.17, 0.08, (cx, cy2, 0.62), frame, verts=20)
    cylinder(0.19, 0.08, (cx, cy2, CHIMNEY_TOP), frame, verts=20, bevel=0.01)
    cylinder(0.13, 0.03, (cx, cy2, CHIMNEY_TOP + 0.03), soot, verts=20)

    with layer('fire'):
        t = ctx.frame_of('fire')
        flicker = [(1.0, 0.8, 0.9), (0.85, 1.0, 0.75), (0.95, 0.75, 1.0), (0.8, 0.95, 0.85)][t]
        hot = m.emissive('fire_hot', 0xffd070, strength=1.1)
        warm = m.emissive('fire_warm', 0xf07020, strength=0.9)
        embers = m.emissive('embers', 0xa02a0c, strength=0.8)
        # Behind the door's grate.
        box((0.46, 0.04, 0.22), (0, door_y + 0.03, 0.32), embers, bevel=0.0)
        for i, x in enumerate((-0.13, 0.0, 0.13)):
            s = flicker[i]
            sphere(0.08, (x, door_y + 0.05, 0.26 + 0.04 * s), warm, scale=(0.9, 0.3, 1.3 * s))
            sphere(0.045, (x, door_y + 0.03, 0.25 + 0.03 * s), hot, scale=(0.9, 0.3, 1.2 * s))
        # In the side vents.
        for sx in (-1, 1):
            box((0.03, 0.68, 0.08), (sx * 0.762, fy, 0.3), warm if t % 2 == 0 else embers, bevel=0.0)
        # Embers glowing in the chimney's mouth.
        cylinder(0.12, 0.02, (cx, cy2, CHIMNEY_TOP + 0.045), embers, verts=20)
        cylinder(0.06 + 0.02 * flicker[1], 0.02, (cx, cy2, CHIMNEY_TOP + 0.05), warm, verts=16)
