"""
The inserters (burner, electric, fast, long-handed), in the `logistics`
atlas. Each is a static base (`body`, built facing north: it picks up from
the south and drops to the north) and its arm (`arm`): 32 pre-rendered
angles of a full turn, the same for every direction (`shared`), with no
shadow of its own. Frame k shows the arm pointing at angle 2πk/32 on
screen, clockwise from east (the game's `armTip` convention: 0 east, a
quarter turn south); the game picks the nearest one and turns the sprite
the rest of the way about the `pivot` point, and draws the held item at the
`hand` point (the hand of frame 0, pointing east; its distance from the
pivot is the arm's reach, `armLength` in the game: 0.8 tile, 1.8 for the
long-handed inserter).

Every type keeps its family color from the prototypes on its housing and
arm: blue electric, red fast, green long-handed; the burner inserter has a
rust-red housing with a firebox and a bare dark iron arm (so it doesn't read
as a fast one).
"""

import math

from bwart import materials as m
from bwart.shapes import box, cylinder, layer, prism, sphere

ARM_ANGLES = 32
PIVOT_Z = 0.38
HAND_Z = 0.2

TYPES = (
    # name, color, arm length (tiles), burner
    ('burner-inserter', 0xB5562F, 0.8, True),
    ('electric-inserter', 0x3F7FC8, 0.8, False),
    ('fast-inserter', 0xC8443C, 0.8, False),
    ('long-handed-inserter', 0x4F9A4A, 1.8, False),
)


def base(name, color, burner):
    paint = m.paint('ins_paint_' + name, color, amount=0.12)
    frame = m.dark_iron()
    iron = m.iron()
    hazard = m.paint('hazard', 'hazard', amount=0.2)
    # Footplate with corner bolts, and a hazard chevron at the drop edge (north).
    box((0.74, 0.74, 0.07), (0, 0, 0.035), frame, bevel=0.025)
    for sx in (-1, 1):
        for sy in (-1, 1):
            cylinder(0.026, 0.014, (sx * 0.3, sy * 0.3, 0.076), iron, verts=10)
    chevron = [(-0.12, 0.27), (0.0, 0.33), (0.12, 0.27), (0.12, 0.31), (0.0, 0.365), (-0.12, 0.31)]
    prism(chevron, 0.01, (0, 0, 0.068), hazard, bevel=0.0)
    # The turret housing in the family color.
    cylinder(0.26, 0.15, (0, 0, 0.145), paint, verts=32, bevel=0.015)
    cylinder(0.28, 0.035, (0, 0, 0.085), frame, verts=32, bevel=0.008)
    cylinder(0.14, 0.03, (0, 0, 0.225), frame, verts=24, bevel=0.006)
    if burner:
        # A small firebox at the back, with a brass hatch.
        box((0.3, 0.12, 0.13), (0, -0.27, 0.135), paint, bevel=0.018)
        box((0.18, 0.02, 0.08), (0, -0.335, 0.135), m.worn('brass', 'brass', metallic=0.7, roughness=0.32, amount=0.15), bevel=0.008)
    else:
        # A cable box at the back.
        box((0.26, 0.11, 0.1), (0, -0.27, 0.12), frame, bevel=0.015)
        box((0.16, 0.02, 0.035), (0, -0.328, 0.13), hazard, bevel=0.005)


def arm(name, color, length, angle, burner):
    """The arm turned to `angle` (radians on screen, clockwise from east)."""
    # A burner inserter's arm is bare dark iron (its housing is the rust-red part); the others are painted.
    paint = m.dark_iron() if burner else m.paint('ins_paint_' + name, color, amount=0.12)
    frame = m.dark_iron()
    steel = m.worn('ins_steel', 0xb8bec6, wear=0x7a8088, metallic=0.7, roughness=0.32, amount=0.1)
    # Screen angles turn clockwise; the model's +Y is north, so a screen angle a points along (cos a, -sin a).
    dx, dy = math.cos(angle), -math.sin(angle)
    rot = (0.0, 0.0, -angle)
    # The pivot post and its joint.
    cylinder(0.075, 0.14, (0, 0, 0.28), steel, verts=20)
    sphere(0.095, (0, 0, PIVOT_Z), frame, segments=20)
    # The beam out to the hand, sloping down a little, and a steel rod under it.
    reach = length - 0.04
    drop = PIVOT_Z - (HAND_Z + 0.12)
    tilt = math.atan2(drop, reach)
    mid = reach / 2
    box(
        (math.hypot(reach, drop), 0.12 if length < 1 else 0.1, 0.075),
        (dx * mid, dy * mid, PIVOT_Z - drop / 2 + 0.01),
        paint,
        bevel=0.018,
        rot=(0.0, tilt, -angle),
    )
    box(
        (math.hypot(reach - 0.08, drop), 0.04, 0.03),
        (dx * (mid + 0.03), dy * (mid + 0.03), PIVOT_Z - 0.055 - drop / 2),
        steel,
        bevel=0.008,
        rot=(0.0, tilt, -angle),
    )
    if length > 1:
        # A long arm is braced in two places along the beam.
        for k in (0.36, 0.68):
            box((0.05, 0.13, 0.04), (dx * reach * k, dy * reach * k, PIVOT_Z - drop * k + 0.05), frame, bevel=0.008, rot=rot)
    # The hand: a wrist joint and two fingers hanging down over the target tile.
    hx, hy = dx * length, dy * length
    cylinder(0.07, 0.07, (hx, hy, HAND_Z + 0.12), frame, verts=20)
    box((0.09, 0.19, 0.04), (hx, hy, HAND_Z + 0.07), steel, bevel=0.01, rot=rot)
    for side in (-1, 1):
        ox, oy = -dy * side * 0.075, dx * side * 0.075
        box((0.05, 0.03, 0.12), (hx + ox, hy + oy, HAND_Z + 0.01), frame, bevel=0.008, rot=rot)


def model(name, color, length, burner):
    def build(ctx):
        base(name, color, burner)
        with layer('arm'):
            arm(name, color, length, ctx.t('arm') * 2 * math.pi, burner)

    return {
        'name': name,
        'atlas': 'logistics',
        'footprint': (1, 1),
        'height': 0.45,
        'directions': 4,
        'extent': length + 0.15,
        'points': {'pivot': (0.0, 0.0, PIVOT_Z), 'hand': (length, 0.0, HAND_Z)},
        'layers': [
            {'name': 'body'},
            {'name': 'arm', 'frames': ARM_ANGLES, 'advance': 'never', 'shared': True, 'shadow': False},
        ],
        'build': build,
    }


MODELS = [model(*spec) for spec in TYPES]
