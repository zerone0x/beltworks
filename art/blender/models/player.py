"""
The player: a small engineer in a safety-orange work suit with an off-white
helmet and a dark visor, a steel life-support pack on the back with a green
status lamp, dark boots, gloves and belt. Chunky proportions (a big helmet,
short limbs) so the figure reads at 1x: about 1.2 tiles tall, a tile on
screen. The orange is the one color no entity family uses, so the player
stands out on grass, ore, belts and buildings alike.

Three models in the `player` atlas, 8 directions each (the driver turns the
root an eighth of a turn per direction; docs/ART.md), all with a shadow:

- `player`: standing idle, one frame.
- `player:walk`: a run cycle of 8 frames (two strides), one cycle per
  16 simulation ticks (fps 30); the game advances it only while the player
  walks under its own power (src/render/playerSprites.ts).
- `player:mine`: hand-mining, a two-handed pickaxe swing of 8 frames that
  strikes on the last frames; the game plays one swing per unit mined, timed
  off the mining progress.

The figure is posed by forward kinematics: legs and arms are pitched about
the hips and shoulders, the upper body leans about the hips, and the body is
lifted so the lower foot stands on the ground.
"""

import math

from mathutils import Matrix, Vector

from bwart import materials as m
from bwart.shapes import box, cylinder, sphere

# Proportions (tiles).
ANKLE = 0.075
THIGH = 0.235
SHIN = 0.235
HIP_X = 0.085
LEG_R = 0.07
SHOULDER_X = 0.2
SHOULDER_Z = 0.36  # above the hips
UPPER_ARM = 0.18
FOREARM = 0.17
ARM_R = 0.058
HEAD_Z = 0.5  # helmet center above the hips
HELMET_R = 0.155

WALK_FRAMES = 8
MINE_FRAMES = 8

COMMON = {
    'atlas': 'player',
    'footprint': (1, 1),
    'directions': 8,
    'margin': 0.12,
    'shadow_reach': 1.25,
}

MODELS = [
    dict(COMMON, name='player', height=1.25, pose='idle'),
    dict(
        COMMON,
        name='player:walk',
        height=1.25,
        pose='walk',
        layers=[{'name': 'body', 'frames': WALK_FRAMES, 'fps': 30, 'advance': 'always'}],
    ),
    dict(
        COMMON,
        name='player:mine',
        height=1.7,
        extent=0.7,
        pose='mine',
        layers=[{'name': 'body', 'frames': MINE_FRAMES, 'fps': 16, 'advance': 'always'}],
    ),
]


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def keyed(t, keys):
    """Value at `t` (0..1, cyclic) of `(time, value)` keys, eased between them."""
    keys = sorted(keys)
    keys = keys + [(keys[0][0] + 1.0, keys[0][1])]
    t = t % 1.0
    if t < keys[0][0]:
        t += 1.0
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t0 <= t <= t1:
            return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0))
    return keys[0][1]


def pose_idle(_t):
    return {
        'lean': 0.02,
        'legs': [(0.03, 0.06, 0.0), (-0.03, 0.06, 0.0)],
        'arms': [(0.08, 0.35, 0.16), (0.02, 0.3, 0.16)],
        'stance': 0.1,
        'tool': None,
    }


def pose_walk(t):
    p = 2 * math.pi * t
    legs = []
    arms = []
    for side in (0, 1):
        q = p + side * math.pi
        swing = 0.62 * math.sin(q)
        # The knee folds while the leg swings forward (cos q > 0) and stays nearly straight on the ground.
        knee = 0.12 + 1.15 * max(0.0, math.cos(q)) ** 1.5
        legs.append((swing, knee, 0.0))
        # Arms swing against the legs, elbows bent like a runner's.
        arms.append((-0.6 * math.sin(q), 1.15, 0.1))
    return {'lean': 0.16, 'legs': legs, 'arms': arms, 'stance': 0.075, 'tool': None}


def pose_mine(t):
    # Raise the pick overhead, hold, strike down in front on the last frames, recover.
    keys = [(0.0, 0.55), (0.45, 2.75), (0.62, 2.85), (0.86, 0.35), (0.95, 0.45)]
    s = keyed(t, keys)
    elbow = keyed(t, [(0.0, 0.5), (0.45, 0.75), (0.62, 0.7), (0.86, 0.15), (0.95, 0.35)])
    lean = keyed(t, [(0.0, 0.18), (0.45, -0.06), (0.62, -0.08), (0.86, 0.32), (0.95, 0.24)])
    # Both hands on the handle: the arms reach in towards the middle (negative roll).
    return {
        'lean': lean,
        'legs': [(0.3, 0.32, 0.0), (-0.22, 0.2, 0.0)],
        'arms': [(s, elbow, -0.32), (s, elbow, -0.32)],
        'stance': 0.11,
        'tool': 'pick',
    }


POSES = {'idle': pose_idle, 'walk': pose_walk, 'mine': pose_mine}


def limb_dir(pitch, roll, side):
    """Unit vector of a limb hanging down, pitched forward (+Y) by `pitch` and rolled outward by `roll`."""
    return Vector((side * math.sin(roll), math.sin(pitch) * math.cos(roll), -math.cos(pitch) * math.cos(roll))).normalized()


def segment(a, b, r, mat, r2=None, verts=14):
    """A rounded limb segment from `a` to `b`."""
    a, b = Vector(a), Vector(b)
    d = b - a
    rot = d.to_track_quat('Z', 'Y').to_euler()
    cylinder(r, d.length, (a + b) / 2, mat, rot=rot, verts=verts, radius2=r2)
    sphere(r, a, mat, segments=verts)
    sphere(r if r2 is None else r2, b, mat, segments=verts)


def build(ctx):
    pose = POSES[ctx.model['pose']](ctx.t('body'))

    suit = m.worn('suit', 0xe2782a, wear=0xb35a1e, metallic=0.0, roughness=0.62, amount=0.12, scale=9.0)
    white = m.paint('helmet', 0xdfe2e4, amount=0.04)
    dark = m.plain('suit_dark', 0x2c3035, roughness=0.7)
    visor = m.plain('visor', 0x16304a, metallic=0.3, roughness=0.12)
    steel = m.worn('pack', 0x7c8791, metallic=0.5, roughness=0.42, amount=0.1, scale=12.0)
    lamp = m.emissive('pack_lamp', 0x7cf06a, strength=1.2)
    wood = m.wood()
    iron = m.dark_iron()

    stance = pose['stance']
    # Legs: hip at the origin of the leg, the ankle where pitch and knee put it.
    leg_points = []
    for i, (pitch, knee, _roll) in enumerate(pose['legs']):
        side = -1 if i == 0 else 1
        hip = Vector((side * stance, 0.0, 0.0))
        k = hip + THIGH * limb_dir(pitch, 0.0, side)
        a = k + SHIN * limb_dir(pitch - knee, 0.0, side)
        leg_points.append((hip, k, a, pitch - knee))
    hip_z = ANKLE - min(a.z for _h, _k, a, _p in leg_points)
    lift = Vector((0.0, 0.0, hip_z))

    for hip, k, a, shin in leg_points:
        segment(hip + lift, k + lift, LEG_R, suit, verts=12)
        segment(k + lift, a + lift, LEG_R, suit, r2=LEG_R * 0.9, verts=12)
        # Boot: flat on the ground when the leg stands, tipped with the shin as it swings.
        tip = max(-0.6, min(0.6, shin * 0.6)) if a.z + hip_z > ANKLE + 0.01 else 0.0
        foot = a + lift + Vector((0.0, 0.045, -0.035))
        box((0.115, 0.2, 0.09), foot, dark, bevel=0.03, rot=(-tip, 0.0, 0.0))

    # Upper body, leaning forward about the hips.
    pivot = Vector((0.0, 0.0, hip_z))
    lean = Matrix.Rotation(-pose['lean'], 4, 'X')

    def up(x, y, z):
        return pivot + lean @ Vector((x, y, z))

    rot = (-pose['lean'], 0.0, 0.0)
    box((0.27, 0.17, 0.12), up(0, 0, 0.03), dark, bevel=0.04, rot=rot, name='belt')
    box((0.36, 0.22, 0.27), up(0, 0, 0.21), suit, bevel=0.07, rot=rot, name='torso')
    # Chest plate and a little hazard tab on it.
    box((0.22, 0.04, 0.12), up(0, 0.1, 0.25), white, bevel=0.015, rot=rot, name='chest')
    box((0.06, 0.012, 0.03), up(0.05, 0.123, 0.27), lamp, bevel=0.0, rot=rot, name='badge')
    # Life-support pack on the back, with two tanks and a status lamp.
    box((0.28, 0.12, 0.3), up(0, -0.155, 0.23), steel, bevel=0.035, rot=rot, name='pack')
    for sx in (-1, 1):
        cylinder(0.045, 0.3, up(sx * 0.085, -0.225, 0.24), steel, rot=rot, verts=14, bevel=0.01)
    sphere(0.025, up(0.0, -0.22, 0.4), lamp, segments=10)
    # Neck ring and helmet with a wide visor.
    cylinder(0.085, 0.06, up(0, 0, 0.37), dark, rot=rot, verts=20)
    sphere(HELMET_R, up(0, 0, HEAD_Z), white, segments=24)
    visor_obj = sphere(HELMET_R * 0.9, up(0, 0.06, HEAD_Z - 0.01), visor, segments=24)
    visor_obj.scale = (1.02, 0.9, 0.8)
    visor_obj.rotation_euler = rot

    # Arms from the shoulders, which lean with the body.
    hands = []
    for i, (pitch, elbow, roll) in enumerate(pose['arms']):
        side = -1 if i == 0 else 1
        shoulder = up(side * SHOULDER_X, 0.0, SHOULDER_Z - 0.04)
        sphere(0.07, shoulder, suit, segments=14)
        d1 = lean @ limb_dir(pitch, roll, side)
        e = shoulder + UPPER_ARM * d1
        d2 = lean @ limb_dir(pitch + elbow, roll, side)
        h = e + FOREARM * d2
        segment(shoulder, e, ARM_R, suit, verts=12)
        segment(e, h, ARM_R, suit, r2=ARM_R * 0.9, verts=12)
        sphere(0.052, h, dark, segments=12)
        hands.append((h, d2))

    if pose['tool'] == 'pick':
        # The handle runs through both hands and on along the forearms; the head across its end.
        h = (hands[0][0] + hands[1][0]) / 2
        d = (hands[0][1] + hands[1][1]).normalized()
        start = h - d * 0.06
        end = h + d * 0.36
        segment(start, end, 0.022, wood, verts=10)
        # Head: perpendicular to the handle in the swing plane, the point leading the strike.
        n = Vector((0.0, d.z, -d.y)).normalized()
        segment(end - n * 0.08, end + n * 0.15, 0.03, iron, r2=0.012, verts=10)
