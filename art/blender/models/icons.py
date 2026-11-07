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
    item = ctx.model['item']
    main, wear, metallic, rough = ORE[item]
    mat = m.worn(f'icon_{item}', main, wear=wear, metallic=metallic, roughness=rough, amount=0.28, scale=5.0)
    rng = terrain.seeded('icon', item)
    for x, y, r in ((-0.2, 0.08, 0.26), (0.2, 0.12, 0.24), (0.02, -0.16, 0.28), (0.04, 0.22, 0.2)):
        terrain.rock_mesh('chunk', r, (x, y, 0.0), mat, rng, squash=0.7 if item != 'coal' else 0.6, rough=0.3)


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


def belt(ctx):
    color = BELT_COLORS[ctx.model['item']]
    yellow = m.paint(f'icon_belt_{color:06x}', color, amount=0.1)
    rubber = m.plain('icon_belt', 0x2a2b2e, roughness=0.7)
    box((0.7, 1.0, 0.1), (0, 0, 0.12), rubber, bevel=0.02)
    for k in range(5):
        box((0.62, 0.05, 0.02), (0, -0.4 + k * 0.2, 0.18), m.plain('icon_ridge', 0x45464a), bevel=0.0)
    for s in (-1, 1):
        box((0.1, 1.04, 0.2), (s * 0.4, 0, 0.1), yellow, bevel=0.025)
    # An arrow showing which way it runs.
    box((0.08, 0.3, 0.02), (0, -0.05, 0.2), yellow, bevel=0.0)
    box((0.22, 0.06, 0.02), (-0.06, 0.12, 0.2), yellow, bevel=0.0, rot=(0, 0, 0.8))
    box((0.22, 0.06, 0.02), (0.06, 0.12, 0.2), yellow, bevel=0.0, rot=(0, 0, -0.8))


def underground(ctx):
    """An underground belt's entrance: a short belt running into a hooded block."""
    color = BELT_COLORS[ctx.model['item']]
    paint = m.paint(f'icon_belt_{color:06x}', color, amount=0.1)
    rubber = m.plain('icon_belt', 0x2a2b2e, roughness=0.7)
    frame = m.dark_iron()
    box((0.62, 0.5, 0.1), (0, -0.25, 0.12), rubber, bevel=0.02)
    for s in (-1, 1):
        box((0.1, 0.52, 0.2), (s * 0.36, -0.25, 0.1), paint, bevel=0.025)
    # The hood: a block with a dark mouth facing the belt.
    box((0.82, 0.55, 0.5), (0, 0.27, 0.25), paint, bevel=0.04)
    box((0.86, 0.3, 0.08), (0, 0.4, 0.52), frame, bevel=0.02)
    box((0.5, 0.06, 0.28), (0, -0.01, 0.19), m.plain('icon_mouth', 0x141414), bevel=0.0)


def inserter(ctx):
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
    cylinder(0.36, 0.14, (0, 0, 0.07), frame, verts=24, bevel=0.02)
    cylinder(0.26, 0.14, (0, 0, 0.2), paint, verts=24, bevel=0.02)
    # Arm: up and forward, then a hand.
    reach = 0.75 if long else 0.5
    pipe([(0, 0, 0.26), (0, 0.15, 0.75), (0, 0.15 + reach, 0.6)], 0.07, paint)
    sphere(0.09, (0, 0.15, 0.75), frame, segments=12)
    box((0.26, 0.1, 0.16), (0, 0.2 + reach, 0.5), frame, bevel=0.02)
    if item == 'burner-inserter':
        cylinder(0.05, 0.2, (0.22, -0.1, 0.32), m.iron(), verts=10)


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
        icon('underground-belt', underground),
        icon('fast-underground-belt', underground),
        icon('express-underground-belt', underground),
        icon('burner-inserter', inserter),
        icon('electric-inserter', inserter),
        icon('fast-inserter', inserter),
        icon('long-handed-inserter', inserter),
        icon('small-electric-pole', pole),
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
        )
    ]
)

# A model module needs `build`; every icon brings its own (or its `from` model's).
build = None
