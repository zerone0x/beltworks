"""
Burner mining drill (2x2, 4 directions), modeled facing north. Three blocks
with clear jobs, so the silhouette reads at 1x:

- the firebox housing across the rear half, with a fire vent on top, a door
  at the back and a short stout chimney at the rear right;
- the drill head, a taller block at the front right, with the drive gear
  sunk into a well in its top (only its rim of teeth shows);
- the output chute at the front left: a wide, light trough that runs out of
  the housing, down over a low deck and past the front edge, ending in a
  hazard-yellow lip over the tile the drill drops onto (docs/DECISIONS.md,
  D12).

Layers: `body`; `fire`, the glow of the firebox through its vent and door,
while it works; `head`, the drive gear, turning while the drill works (a
third of a turn over 8 frames: the gear has 3 spokes and 12 teeth, so it
lines up again where the loop starts over).
"""

import math

from bwart import materials as m
from bwart.shapes import box, cylinder, gear, layer

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

SKID = 0.1
HOUSING_TOP = 0.66
HEAD_TOP = 0.9
DECK_TOP = 0.26
HEAD = (0.44, 0.44)  # drill head center (x, y)
CHUTE_X = -0.48


def build(ctx):
    housing = m.paint('drill_housing', 0x9a5536, amount=0.18)
    frame = m.dark_iron()
    iron = m.iron()
    brass = m.worn('brass', 'brass', metallic=0.7, roughness=0.32, amount=0.15)
    soot = m.plain('soot', 'soot', roughness=1.0)
    hazard = m.paint('hazard', 'hazard', amount=0.12)

    # Skid.
    box((1.9, 1.9, SKID), (0, 0, SKID / 2), frame, bevel=0.03)

    # Firebox housing over the rear half.
    hy, hd = -0.46, 0.9
    hh = HOUSING_TOP - SKID
    box((1.76, hd, hh), (0, hy, SKID + hh / 2), housing, bevel=0.04)
    zt = HOUSING_TOP + 0.01
    # Vent at the rear left: a dark well with bars across it (the fire layer glows in it).
    vx, vy = -0.36, hy - 0.06
    box((0.62, 0.42, 0.03), (vx, vy, zt), soot, bevel=0.0)
    for i in range(4):
        box((0.045, 0.46, 0.04), (vx - 0.22 + i * 0.147, vy, zt + 0.015), frame, bevel=0.0)
    # Fire door at the back.
    box((0.44, 0.04, 0.3), (-0.3, hy - hd / 2 - 0.02, 0.34), frame, bevel=0.015)
    for i in range(3):
        box((0.32, 0.05, 0.03), (-0.3, hy - hd / 2 - 0.04, 0.26 + i * 0.07), soot, bevel=0.0)
    # Short stout chimney at the rear right.
    cx, cy = 0.5, hy - 0.08
    cylinder(0.14, 0.4, (cx, cy, zt + 0.2), iron, verts=20)
    cylinder(0.17, 0.06, (cx, cy, zt + 0.4), frame, verts=20)
    cylinder(0.11, 0.02, (cx, cy, zt + 0.43), soot, verts=20)

    # Drill head at the front right: a taller block, the gear sunk into its top.
    hx, hy2 = HEAD
    head_w = 0.84
    box((head_w, head_w, HEAD_TOP - SKID), (hx, hy2, (HEAD_TOP + SKID) / 2), housing, bevel=0.04)
    cylinder(0.38, 0.03, (hx, hy2, HEAD_TOP + 0.005), frame, verts=32)
    cylinder(0.33, 0.03, (hx, hy2, HEAD_TOP + 0.012), soot, verts=32)
    # Bolts at the corners of the top.
    for sx in (-1, 1):
        for sy in (-1, 1):
            cylinder(0.035, 0.04, (hx + sx * 0.35, hy2 + sy * 0.35, HEAD_TOP + 0.03), iron, verts=8)
    # The drill bit's collar under the head, at the front.
    box((0.5, 0.06, 0.2), (hx, hy2 + head_w / 2 + 0.02, SKID + 0.12), frame, bevel=0.015)

    # Low deck at the front left that the chute runs over.
    box((0.86, 0.86, DECK_TOP - SKID), (CHUTE_X + 0.04, 0.44, (DECK_TOP + SKID) / 2), frame, bevel=0.03)

    # Output chute: from a dark mouth in the housing's front, down past the front edge.
    mouth_y = hy + hd / 2
    box((0.62, 0.04, 0.3), (CHUTE_X, mouth_y + 0.01, 0.46), soot, bevel=0.0)
    box((0.7, 0.08, 0.06), (CHUTE_X, mouth_y + 0.03, 0.63), frame, bevel=0.015)
    y0, z0 = mouth_y, 0.5  # top of the trough's floor
    y1, z1 = 1.16, 0.3  # its lip (the render frame has 0.25 tile of margin)
    run = math.hypot(y1 - y0, z1 - z0)
    tilt = math.atan2(z1 - z0, y1 - y0)  # negative: sloping down to the front
    mid = ((y0 + y1) / 2, (z0 + z1) / 2)
    width = 0.58
    rot = (tilt, 0, 0)
    box((width, run, 0.05), (CHUTE_X, mid[0], mid[1]), iron, bevel=0.012, rot=rot)
    # Side walls, standing on the floor (local Z of the tilted floor is (0, -sin, cos)).
    up = 0.07
    for sx in (-1, 1):
        box(
            (0.05, run, 0.17),
            (CHUTE_X + sx * (width / 2 + 0.02), mid[0] - math.sin(tilt) * up, mid[1] + math.cos(tilt) * up),
            frame,
            bevel=0.012,
            rot=rot,
        )
    # Hazard-yellow lip across the end, and a strut under it down to the deck.
    box((width + 0.1, 0.07, 0.1), (CHUTE_X, y1 + 0.01, z1 + 0.01), hazard, bevel=0.015)
    for sx in (-1, 1):
        box((0.05, 0.05, z1 - DECK_TOP + 0.06), (CHUTE_X + sx * 0.22, 0.86, (z1 + DECK_TOP) / 2 + 0.02), frame, bevel=0.01)

    with layer('fire'):
        glow = m.emissive('fire_glow', 0xf07020, strength=1.6)
        box((0.58, 0.38, 0.02), (vx, vy, zt + 0.005), glow, bevel=0.0)
        box((0.32, 0.02, 0.22), (-0.3, hy - hd / 2 - 0.035, 0.33), glow, bevel=0.0)

    with layer('head'):
        turn = ctx.t('head') * (2 * math.pi / 3)
        zg = HEAD_TOP + 0.03
        gear(0.31, 12, 0.05, (hx, hy2, zg), brass, phase=-turn)
        cylinder(0.08, 0.06, (hx, hy2, zg + 0.03), frame, verts=16)
        for k in range(3):
            a = -turn + k * 2 * math.pi / 3
            box((0.2, 0.06, 0.03), (hx + math.cos(a) * 0.14, hy2 + math.sin(a) * 0.14, zg + 0.03), frame, rot=(0, 0, a), bevel=0.01)
