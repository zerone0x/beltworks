"""
Ground decor (atlas `terrain`): small details scattered over the ground so
it doesn't look like a repeating texture: tufts of grass, flowers and
bushes on grass (`decor-grass-<v>`), pebbles and dry grass on sand
(`decor-sand-<v>`), stones and rubble on rock (`decor-rock-<v>`). They are
low and catch their own shadow, like ore decals; the game sprinkles them on
a hash of the tile (src/render/terrainArt.ts) and never on ore or trees.
"""

import math

from bwart import materials as m
from bwart import terrain
from bwart.shapes import cylinder, sphere


def tuft(rng, x, y, color, height=0.14, blades=9):
    mat = m.plain(f'blade_{color:06x}', color, roughness=0.8)
    for _ in range(blades):
        a = rng.uniform(0, 2 * math.pi)
        tilt = rng.uniform(0.15, 0.5)
        h = height * rng.uniform(0.6, 1.1)
        cylinder(0.012, h, (x + math.cos(a) * tilt * h / 2, y + math.sin(a) * tilt * h / 2, h / 2), mat, verts=4, radius2=0.002, rot=(-math.sin(a) * tilt, math.cos(a) * tilt, 0))


def build_grass(ctx):
    v = ctx.variant
    rng = terrain.seeded('decor-grass', v)
    if v in (0, 1):
        # Tufts of taller grass.
        for _ in range(3 + v):
            tuft(rng, rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), rng.choice([0x55802f, 0x4a7428, 0x6a8a38]))
    elif v in (2, 3):
        # Flowers: white or yellow dots on short stems among a tuft.
        tuft(rng, 0.0, 0.0, 0x4f7a2c, height=0.1, blades=7)
        petal = m.plain('petal_white', 0xf0eee0, roughness=0.6) if v == 2 else m.plain('petal_yellow', 0xf0c838, roughness=0.6)
        for _ in range(7):
            x, y = rng.uniform(-0.32, 0.32), rng.uniform(-0.32, 0.32)
            h = rng.uniform(0.05, 0.1)
            cylinder(0.008, h, (x, y, h / 2), m.plain('stem', 0x3f6a26), verts=4)
            sphere(0.028, (x, y, h), petal, segments=8, scale=(1, 1, 0.5))
    elif v == 4:
        # A low bush.
        leaves = terrain.foliage('bush', 0x4f7f32, 0x35592a, 0x6e9a44)
        for k in range(4):
            a = k * 1.7
            terrain.blob('bush', rng.uniform(0.12, 0.17), (math.cos(a) * 0.1, math.sin(a) * 0.1, 0.09), leaves, (k, 2.0, 5.0), scale=(1, 1, 0.75))
    else:
        # A mossy stone among grass.
        terrain.rock_mesh('stone', 0.13, (0.05, 0.0, 0.0), m.stone('mossy', base=0x7f7a6e), rng, squash=0.55)
        tuft(rng, -0.15, 0.1, 0x4a7428, height=0.1, blades=6)


def build_sand(ctx):
    v = ctx.variant
    rng = terrain.seeded('decor-sand', v)
    if v < 2:
        pebble = [m.stone('pebble_a', base=0x9a8c72), m.stone('pebble_b', base=0x7c7262), m.stone('pebble_c', base=0xb0a488)]
        for _ in range(4 + 2 * v):
            terrain.rock_mesh('pebble', rng.uniform(0.03, 0.06), (rng.uniform(-0.35, 0.35), rng.uniform(-0.35, 0.35), 0.0), rng.choice(pebble), rng, squash=0.5)
    elif v == 2:
        tuft(rng, 0.0, 0.0, 0x9a9050, height=0.16, blades=10)
    else:
        terrain.rock_mesh('stone', 0.12, (0.0, 0.0, 0.0), m.stone('sandstone', base=0xa8936a), rng, squash=0.5)


def build_rock(ctx):
    v = ctx.variant
    rng = terrain.seeded('decor-rock', v)
    mats = [m.stone('boulder_a', base=0x77726a), m.stone('boulder_b', base=0x5f5b55), m.stone('boulder_c', base=0x8a8478)]
    if v < 2:
        terrain.rock_mesh('boulder', 0.2 + 0.04 * v, (0.0, 0.0, 0.0), rng.choice(mats), rng, squash=0.65, rough=0.3)
        for _ in range(3):
            terrain.rock_mesh('rubble', rng.uniform(0.04, 0.07), (rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 0.0), rng.choice(mats), rng, squash=0.5)
    else:
        for _ in range(5 + v):
            terrain.rock_mesh('rubble', rng.uniform(0.04, 0.09), (rng.uniform(-0.35, 0.35), rng.uniform(-0.35, 0.35), 0.0), rng.choice(mats), rng, squash=0.5)


COMMON = {'atlas': 'terrain', 'footprint': (1, 1), 'height': 0.35, 'margin': 0.1, 'shadow': 'catch', 'shadow_reach': 0.3}

MODELS = [
    dict(COMMON, name='decor-grass', variants=6, build=build_grass),
    dict(COMMON, name='decor-sand', variants=4, build=build_sand),
    dict(COMMON, name='decor-rock', variants=4, build=build_rock),
]
