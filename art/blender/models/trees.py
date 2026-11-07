"""
Trees (atlas `terrain`): six variants, `tree-0` .. `tree-5`. Four broadleaf
trees (a short trunk under a canopy of lumpy foliage clumps, in a few
shades of green) and two conifers (tiers of drooping cones). They stand on
one tile and reach up to about two tiles, so their canopies overlap the
tiles behind them; the game draws them sorted from north to south, with
their shadows in a separate, faded pass (src/render/terrainArt.ts).

Trees are world data, not entities (docs/DECISIONS.md, D18): the game picks
a variant and a small offset from a hash of the tile.
"""

import math

from bwart import materials as m
from bwart import terrain
from bwart.shapes import cylinder

VARIANTS = 6

# Greens per broadleaf variant: (base, dark, light).
LEAVES = [
    (0x3f6e2c, 0x24451a, 0x5f8f3a),
    (0x4a7330, 0x2a4a1c, 0x6e9640),
    (0x386428, 0x1f3e17, 0x548436),
    (0x52762e, 0x30491a, 0x7a9a44),
]


def build(ctx):
    v = ctx.variant
    rng = terrain.seeded('tree', v)
    bark = m.worn('bark', 0x5a4030, wear=0x3a2a20, metallic=0.0, roughness=0.9, amount=0.5, scale=14.0, stretch=(4, 4, 0.6))
    if v >= 4:
        conifer(rng, bark, v)
        return
    base, dark, light = LEAVES[v]
    leaves = terrain.foliage(f'leaves_{v}', base, dark, light)
    height = rng.uniform(0.75, 0.95)
    # Trunk, slightly leaning, with two roots.
    lean = (rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05))
    cylinder(0.09, height, (lean[0] / 2, lean[1] / 2, height / 2), bark, verts=12, radius2=0.06, rot=(lean[1], -lean[0], 0))
    for a in (rng.uniform(0, 3), rng.uniform(3, 6)):
        cylinder(0.04, 0.22, (math.cos(a) * 0.09, math.sin(a) * 0.09, 0.04), bark, verts=8, rot=(math.sin(a) * 1.2, -math.cos(a) * 1.2, 0))
    # Canopy: a big central clump with smaller ones around and on top.
    top = height + 0.3
    terrain.blob('canopy', 0.42, (lean[0], lean[1], top), leaves, (v * 7.0, 1.0, 2.0), scale=(1.0, 1.0, 0.85))
    clumps = 5 + v % 2
    for k in range(clumps):
        a = k * 2 * math.pi / clumps + rng.uniform(-0.3, 0.3)
        r = rng.uniform(0.24, 0.34)
        d = rng.uniform(0.26, 0.36)
        z = top + rng.uniform(-0.18, 0.1)
        terrain.blob('clump', r, (lean[0] + math.cos(a) * d, lean[1] + math.sin(a) * d, z), leaves, (v * 7.0 + k, 3.0 + k, 1.0), scale=(1.0, 1.0, 0.8))
    terrain.blob('crown', 0.3, (lean[0] + rng.uniform(-0.08, 0.08), lean[1] + rng.uniform(-0.08, 0.08), top + 0.3), leaves, (v * 3.0, 9.0, 4.0), scale=(1.0, 1.0, 0.8))


def conifer(rng, bark, v):
    needles = terrain.foliage(f'needles_{v}', 0x2f5a30, 0x1a3820, 0x4a7a44, scale=14.0)
    height = rng.uniform(1.75, 2.0)
    cylinder(0.07, 0.5, (0, 0, 0.25), bark, verts=10, radius2=0.05)
    tiers = 4
    for k in range(tiers):
        f = k / tiers
        z0 = 0.3 + f * (height - 0.55)
        r = 0.5 * (1.0 - f * 0.72) * rng.uniform(0.92, 1.05)
        h = (height - 0.3) / tiers * 1.7
        cone = cylinder(r, h, (0, 0, z0 + h / 2), needles, verts=10, radius2=0.02)
        # Lumpy cones: push the verts in and out a little.
        for vert in cone.data.vertices:
            if vert.co.z < 0:
                vert.co.x *= rng.uniform(0.85, 1.12)
                vert.co.y *= rng.uniform(0.85, 1.12)
                vert.co.z += rng.uniform(-0.05, 0.03)
        for poly in cone.data.polygons:
            poly.use_smooth = True


MODEL = {
    'name': 'tree',
    'atlas': 'terrain',
    'footprint': (1, 1),
    'height': 2.0,
    'shadow_reach': 1.8,
    'variants': VARIANTS,
}
