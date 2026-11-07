"""
Ore decals (atlas `terrain`): what a resource tile shows on the ground. Per
ore (iron, copper, coal, stone), three richness levels (more and bigger
chunks on richer tiles) of three variants each, named
`<ore>-<level>-<variant>`, e.g. `iron-ore-2-1`. Each is a stained patch of
soil with chunks of ore lying on it; the stains of neighbouring tiles merge
into one patch. The chunks catch their own (short) shadows: decals never
overlap, so there is nothing to double up.

The game picks the level from the tile's amount and the variant from a hash
of its position (src/render/terrainArt.ts, `oreDecal`).
"""

import math

from bwart import materials as m
from bwart import terrain

LEVELS = 3
VARIANTS = 3

ORES = {
    # name: (main color, second color, stain color, metallic, roughness)
    'iron-ore': (0x6c7f90, 0x4a5560, 0x4a4f4e, 0.35, 0.45),
    'copper-ore': (0xc06a38, 0x4f8a6a, 0x5a4a38, 0.3, 0.5),
    'coal': (0x232323, 0x3a3a3a, 0x2a2826, 0.0, 0.32),
    'stone': (0xaa9c80, 0x8a7d66, 0x7a705e, 0.0, 0.85),
}


def ore_material(ore):
    main, second, _, metallic, rough = ORES[ore]
    if ore == 'copper-ore':
        # Copper-orange rock with green verdigris spots.
        return m.worn(f'{ore}_rock', main, wear=second, metallic=metallic, roughness=rough, amount=0.3, scale=9.0)
    if ore == 'iron-ore':
        return m.worn(f'{ore}_rock', main, wear=0x8a5a3a, metallic=metallic, roughness=rough, amount=0.22, scale=10.0)
    return m.worn(f'{ore}_rock', main, wear=second, metallic=metallic, roughness=rough, amount=0.35, scale=7.0)


def build(ctx):
    ore = ctx.model['ore']
    level = ctx.model['level']
    rng = terrain.seeded(ore, level, ctx.variant)
    stain_color = ORES[ore][2]
    # Soil stain: a rounded square a bit larger than the tile, so neighbours merge.
    bpy_plane(0.0, terrain.stain(f'{ore}_stain_{level}', stain_color, 0.62 + 0.04 * level, 0.3, alpha=0.32 + 0.18 * level))
    rock = ore_material(ore)
    count = (7, 12, 18)[level]
    size = (0.075, 0.095, 0.11)[level]
    placed = []
    tries = 0
    while len(placed) < count and tries < 400:
        tries += 1
        r = size * rng.uniform(0.6, 1.35)
        x = rng.uniform(-0.48, 0.48)
        y = rng.uniform(-0.48, 0.48)
        if any(math.hypot(x - px, y - py) < (r + pr) * 0.8 for px, py, pr in placed):
            continue
        placed.append((x, y, r))
        squash = 0.45 if ore == 'coal' else 0.6
        terrain.rock_mesh('chunk', r, (x, y, 0.0), rock, rng, squash=squash, rough=0.4)


def bpy_plane(z, mat):
    import bpy

    bpy.ops.mesh.primitive_plane_add(size=1.5, location=(0.0, 0.0, z + 0.002))
    plane = bpy.context.active_object
    plane.data.materials.append(mat)
    from bwart.shapes import _adopt

    _adopt(plane, None)
    return plane


MODELS = [
    {
        'name': f'{ore}-{level}',
        'ore': ore,
        'level': level,
        'atlas': 'terrain',
        'footprint': (1, 1),
        'height': 0.3,
        'margin': 0.25,
        'shadow': 'catch',
        'shadow_reach': 0.2,
        'variants': VARIANTS,
    }
    for ore in ORES
    for level in range(LEVELS)
]
