"""
Item icons (atlas `icons`): a small 3D render of every item, framed to fill
the icon (bwart/scene.py, `frame_icon`), lit like the sprites. Items that
place an entity with a model show that model's idle body (`from`); the rest
are modeled here: ore piles, plates, bricks, logs, intermediates, and simple
stand-ins for the logistics entities (belt, inserters, pole) until they get
models of their own.

Icons are read at a glance at 13 to 26 pixels, on belts, in hands and in
inventory slots: one clear shape and the item's color, nothing fine. The
game keeps the lettered placeholder icons as a fallback and as an option
(src/render/itemIcons.ts).
"""

import math

from bwart import materials as m
from bwart import terrain
from bwart.shapes import box, cylinder, gear, pipe, sphere, torus

ORE = {
    'iron-ore': (0x7d93a6, 0x8a5a3a, 0.35, 0.45),
    'copper-ore': (0xc8743e, 0x4f8a6a, 0.3, 0.5),
    'coal': (0x262626, 0x3e3e3e, 0.0, 0.3),
    'stone': (0xaa9c80, 0x857860, 0.0, 0.85),
}


def ore_pile(ctx):
    """
    A pile of ore with a silhouette of its own, so ores on a belt tell apart
    by shape as well as color: iron in angular blocks, copper in round
    nuggets, coal in flat glossy shards, stone as one big boulder.
    """
    item = ctx.model['item']
    main, wear, metallic, rough = ORE[item]
    mat = m.worn(f'icon_{item}', main, wear=wear, metallic=metallic, roughness=rough, amount=0.28, scale=5.0)
    rng = terrain.seeded('icon', item)
    if item == 'iron-ore':
        # Blocky, crystalline chunks: beveled boxes, one stacked on two.
        for size, loc, rot in (
            ((0.42, 0.4, 0.34), (-0.22, 0.02, 0.17), (0.0, 0.0, 0.35)),
            ((0.4, 0.38, 0.32), (0.22, 0.06, 0.16), (0.0, 0.0, -0.3)),
            ((0.38, 0.36, 0.32), (0.0, 0.0, 0.46), (0.25, 0.18, 0.8)),
        ):
            box(size, loc, mat, bevel=0.035, rot=rot)
    elif item == 'copper-ore':
        # Round nuggets, smooth, in a triangle.
        for x, y, z, r in ((-0.25, 0.04, 0.2, 0.25), (0.25, 0.06, 0.19, 0.24), (0.0, -0.04, 0.5, 0.26)):
            terrain.blob('nugget', r, (x, y, z), mat, (x * 13.0, y * 7.0 + 3.0, z * 5.0), lumps=0.14, scale=(1.0, 1.0, 0.85), subdivisions=3)
    elif item == 'coal':
        # Flat shards, tilted and overlapping: a low, jagged silhouette.
        for x, y, z, r, tilt in ((-0.26, 0.05, 0.0, 0.32, 0.25), (0.24, -0.02, 0.0, 0.3, -0.3), (0.0, 0.08, 0.14, 0.3, 0.1)):
            shard = terrain.rock_mesh('shard', r, (x, y, z), mat, rng, squash=0.32, rough=0.5, subdivisions=1)
            shard.rotation_euler.x = tilt
    else:
        # One big rounded boulder with a pebble.
        terrain.rock_mesh('boulder', 0.5, (0.0, 0.0, 0.0), mat, rng, squash=0.75, rough=0.18)
        terrain.rock_mesh('pebble', 0.18, (0.46, -0.3, 0.0), mat, rng, squash=0.7, rough=0.2)


def plates(ctx):
    item = ctx.model['item']
    color, metallic = {'iron-plate': (0xb4bcc4, 0.75), 'copper-plate': (0xd9844a, 0.8)}[item]
    mat = m.worn(f'icon_{item}', color, metallic=metallic, roughness=0.32, amount=0.08, scale=8.0)
    for k in range(3):
        box((0.9, 0.62, 0.1), (k * 0.03, -k * 0.02, 0.05 + k * 0.12), mat, bevel=0.025, rot=(0, 0, k * 0.08))


def bricks(ctx):
    mat = m.stone('icon_brick', base=0xb09060)
    box((0.8, 0.38, 0.26), (0, -0.2, 0.13), mat, bevel=0.03)
    box((0.8, 0.38, 0.26), (0, 0.2, 0.13), mat, bevel=0.03)
    box((0.8, 0.38, 0.26), (0.05, 0.0, 0.39), mat, bevel=0.03, rot=(0, 0, 0.1))


def logs(ctx):
    bark = m.worn('icon_bark', 0x6e4a2c, wear=0x4a3020, metallic=0.0, roughness=0.9, amount=0.5, scale=10.0)
    cut = m.plain('icon_wood_cut', 0xd2a868, roughness=0.8)
    for x, z in ((-0.2, 0.17), (0.2, 0.17), (0.0, 0.47)):
        cylinder(0.17, 0.9, (x, 0, z), bark, rot=(math.pi / 2, 0, 0), verts=16)
        for s in (-1, 1):
            cylinder(0.15, 0.01, (x, s * 0.452, z), cut, rot=(math.pi / 2, 0, 0), verts=16)
            torus(0.08, 0.008, (x, s * 0.458, z), m.plain('icon_ring', 0xa07840), rot=(math.pi / 2, 0, 0), major_segments=16, minor_segments=4)


def gear_wheel(ctx):
    mat = m.worn('icon_gear', 0x8e9aa3, metallic=0.75, roughness=0.35, amount=0.1, scale=8.0)
    gear(0.5, 10, 0.16, (0, 0, 0.08), mat, tooth=0.22)
    cylinder(0.16, 0.2, (0, 0, 0.1), m.dark_iron(), verts=20)
    cylinder(0.07, 0.22, (0, 0, 0.1), m.plain('icon_hole', 0x1a1a1a), verts=16)


def cable(ctx):
    copper = m.worn('icon_copper', 0xe08848, metallic=0.85, roughness=0.3, amount=0.1)
    for k in range(4):
        torus(0.34, 0.06, (0, 0, 0.07 + k * 0.1), copper, major_segments=32, minor_segments=8)
    pipe([(0.34, 0, 0.37), (0.45, -0.2, 0.42), (0.5, -0.45, 0.3)], 0.06, copper)


def circuit(ctx):
    board = m.plain('icon_board', 0x2f7a3a, roughness=0.5)
    chip = m.plain('icon_chip', 0x1c1c20, roughness=0.4)
    gold = m.worn('icon_gold', 0xd8b048, metallic=0.9, roughness=0.3, amount=0.05)
    box((0.9, 0.7, 0.06), (0, 0, 0.03), board, bevel=0.01)
    box((0.36, 0.3, 0.08), (-0.12, 0.05, 0.1), chip, bevel=0.01)
    box((0.18, 0.14, 0.06), (0.26, -0.18, 0.09), chip, bevel=0.01)
    for k in range(5):
        box((0.04, 0.06, 0.02), (-0.24 + k * 0.06, -0.14, 0.07), gold, bevel=0.0)
        box((0.04, 0.06, 0.02), (-0.24 + k * 0.06, 0.24, 0.07), gold, bevel=0.0)
    for y in (-0.26, 0.3):
        box((0.7, 0.025, 0.012), (0.05, y, 0.065), gold, bevel=0.0)


#: Belt tier colors, by item.
BELT_COLORS = {
    'transport-belt': 0xd9b23a,
    'fast-transport-belt': 0xd0473a,
    'express-transport-belt': 0x3a8fd9,
    'underground-belt': 0xd9b23a,
    'fast-underground-belt': 0xd0473a,
    'express-underground-belt': 0x3a8fd9,
}

#: Belt tiers (1..3), shown as that many chevrons, so they differ by shape too.
BELT_TIERS = {
    'transport-belt': 1,
    'fast-transport-belt': 2,
    'express-transport-belt': 3,
    'underground-belt': 1,
    'fast-underground-belt': 2,
    'express-underground-belt': 3,
}


def chevrons(count, y, z, width, mat, pitch=0.24, bar=0.09, depth=0.03):
    """`count` chevrons pointing north (+Y), centered on `y`."""
    arm = width / 2 / math.cos(0.7)
    for k in range(count):
        cy = y + (k - (count - 1) / 2) * pitch
        for s in (-1, 1):
            box((arm, bar, depth), (s * width / 4, cy - width / 4 * math.tan(0.7), z), mat, bevel=0.0, rot=(0, 0, -s * 0.7))


def belt(ctx):
    item = ctx.model['item']
    color = BELT_COLORS[item]
    paint = m.paint(f'icon_belt_{color:06x}', color, amount=0.1)
    rubber = m.plain('icon_belt', 0x2a2b2e, roughness=0.7)
    box((0.72, 1.0, 0.1), (0, 0, 0.12), rubber, bevel=0.02)
    for s in (-1, 1):
        box((0.14, 1.04, 0.2), (s * 0.42, 0, 0.1), paint, bevel=0.025)
    # The tier as chevrons in the tier color: one, two or three.
    chevrons(BELT_TIERS[item], 0.1, 0.18, 0.56, paint)


def underground(ctx):
    """An underground belt's entrance: a short belt running into a hood with tier chevrons."""
    item = ctx.model['item']
    color = BELT_COLORS[item]
    paint = m.paint(f'icon_belt_{color:06x}', color, amount=0.1)
    rubber = m.plain('icon_belt', 0x2a2b2e, roughness=0.7)
    dark = m.plain('icon_chevron_dark', 0x1c1d20, roughness=0.6)
    box((0.62, 0.45, 0.1), (0, -0.3, 0.12), rubber, bevel=0.02)
    for s in (-1, 1):
        box((0.12, 0.47, 0.2), (s * 0.37, -0.3, 0.1), paint, bevel=0.025)
    # The hood: a block with a dark mouth facing the belt, the tier as dark chevrons on its roof.
    box((0.86, 0.8, 0.46), (0, 0.32, 0.23), paint, bevel=0.04)
    box((0.5, 0.06, 0.28), (0, -0.08, 0.19), m.plain('icon_mouth', 0x141414), bevel=0.0)
    chevrons(BELT_TIERS[item], 0.4, 0.47, 0.66, dark, pitch=0.22, bar=0.1, depth=0.02)


def science_pack(ctx):
    """A round flask of colored liquid with a cork."""
    color = {'automation-science-pack': 0xd23c3c, 'logistic-science-pack': 0x3cb44a}[ctx.model['item']]
    liquid = m.plain(f'icon_liquid_{color:06x}', color, roughness=0.2)
    glass = m.plain('icon_glass', 0xc8dce4, metallic=0.0, roughness=0.08)
    sphere(0.36, (0, 0, 0.36), liquid, segments=24)
    cylinder(0.11, 0.3, (0, 0, 0.78), glass, verts=16)
    cylinder(0.12, 0.12, (0, 0, 0.96), m.plain('icon_cork', 0x9a7048, roughness=0.9), verts=16, bevel=0.02)


def inserter(ctx):
    """
    A chunky inserter seen from the side: the arm swings up from the base and
    reaches out sideways to the hand, so the icon fills its square instead of
    being a thin post (it is read at 13 pixels on belts).
    """
    item = ctx.model['item']
    color = {
        'burner-inserter': 0xb5562f,
        'electric-inserter': 0x3f7fc8,
        'fast-inserter': 0xc8443c,
        'long-handed-inserter': 0x4f9a4a,
    }[item]
    paint = m.paint(f'icon_{item}', color, amount=0.1)
    frame = m.dark_iron()
    long = item == 'long-handed-inserter'
    bx = -0.42 if long else -0.3
    box((0.62, 0.62, 0.12), (bx, 0, 0.06), frame, bevel=0.03)
    cylinder(0.25, 0.22, (bx, 0, 0.23), paint, verts=24, bevel=0.03)
    elbow = (bx + 0.14, 0, 0.9)
    reach = 1.05 if long else 0.62
    hand = (bx + 0.14 + reach, 0, 0.5)
    pipe([(bx, 0, 0.32), elbow], 0.1, paint)
    pipe([elbow, hand], 0.08 if long else 0.1, paint)
    sphere(0.13, elbow, frame, segments=14)
    # The hand: a light steel gripper with two fingers (dark iron would vanish on a slot).
    steel = m.worn('icon_steel', 0xb8bec6, metallic=0.6, roughness=0.35, amount=0.05)
    box((0.2, 0.26, 0.18), (hand[0], 0, hand[2]), steel, bevel=0.03)
    for s in (-1, 1):
        box((0.08, 0.07, 0.22), (hand[0] + 0.03, s * 0.09, hand[2] - 0.17), steel, bevel=0.015)
    if item == 'burner-inserter':
        # A smokestack on the base.
        cylinder(0.065, 0.42, (bx - 0.22, -0.2, 0.4), m.iron(), verts=12)
    elif item == 'fast-inserter':
        # Two light stripes across the arm.
        for t in (0.35, 0.6):
            p = (elbow[0] + (hand[0] - elbow[0]) * t, 0, elbow[2] + (hand[2] - elbow[2]) * t)
            along = math.atan2(hand[0] - elbow[0], hand[2] - elbow[2])
            cylinder(0.108, 0.05, p, m.plain('icon_stripe', 0xe8e4d8, roughness=0.5), rot=(0, along, 0), verts=16)


def pole(ctx):
    wood = m.wood('icon_pole_wood', 0x8a6440)
    cylinder(0.08, 1.4, (0, 0, 0.7), wood, verts=12)
    box((0.6, 0.1, 0.1), (0, 0, 1.25), wood, bevel=0.02)
    for s in (-1, 1):
        cylinder(0.05, 0.12, (s * 0.25, 0, 1.36), m.plain('icon_insulator', 0x7a9a6a, roughness=0.3), verts=10)
        cylinder(0.025, 0.06, (s * 0.25, 0, 1.45), m.worn('icon_copper', 0xe08848, metallic=0.85, roughness=0.3, amount=0.1), verts=8)


def icon(item, build=None, **extra):
    spec = {'name': f'icon-{item}', 'item': item, 'kind': 'icon', 'atlas': 'icons'}
    if build is not None:
        spec['build'] = build
    spec.update(extra)
    return spec


MODELS = (
    [icon(item, ore_pile) for item in ORE]
    + [
        icon('wood', logs),
        icon('iron-plate', plates, tilt=0.25),
        icon('copper-plate', plates, tilt=0.25),
        icon('stone-brick', bricks),
        icon('iron-gear-wheel', gear_wheel, tilt=0.3),
        icon('copper-cable', cable),
        icon('electronic-circuit', circuit, tilt=0.35),
        icon('transport-belt', belt, tilt=0.2),
        icon('fast-transport-belt', belt, tilt=0.2),
        icon('express-transport-belt', belt, tilt=0.2),
        icon('underground-belt', underground, tilt=0.2),
        icon('fast-underground-belt', underground, tilt=0.2),
        icon('express-underground-belt', underground, tilt=0.2),
        icon('burner-inserter', inserter),
        icon('electric-inserter', inserter),
        icon('fast-inserter', inserter),
        icon('long-handed-inserter', inserter),
        icon('small-electric-pole', pole),
        icon('automation-science-pack', science_pack),
        icon('logistic-science-pack', science_pack),
    ]
    + [
        icon(name, **{'from': name}, direction=1 if name == 'steam-engine' else 0)
        for name in (
            'wooden-chest',
            'iron-chest',
            'stone-furnace',
            'burner-mining-drill',
            'assembling-machine-1',
            'assembling-machine-2',
            'boiler',
            'steam-engine',
            'electric-mining-drill',
            'lab',
        )
    ]
)

# A model module needs `build`; every icon brings its own (or its `from` model's).
build = None
