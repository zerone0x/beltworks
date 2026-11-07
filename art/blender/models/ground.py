"""
Ground textures (atlas `terrain`): grass, sand, water and rock, each a
seamless texture of PERIOD x PERIOD tiles (bwart/terrain.py), seen through
the game camera and lit like the sprites. The game samples them by world
position, blends neighbouring terrain types with soft, noisy edges and adds
a slow large-scale variation on top, so the period doesn't show
(src/render/terrainArt.ts).

Keep them calm: the ground is the background of everything, so contrast
stays low and detail fine; strong features (rocks, flowers, ore) are
separate decals.
"""

from bwart import terrain

PERIOD = 8


def build_grass(ctx):
    def wire(n, bsdf):
        p = terrain.Periodic(n, PERIOD)
        patches = p.noise(1.6, detail=2.0, offset=1)
        clumps = p.noise(2.2, detail=3.0, roughness=0.6, offset=2)
        blades = p.noise(16.0, detail=2.0, roughness=0.7, offset=3)
        base = n.ramp(patches, [(0.35, 0x3a6329), (0.5, 0x44702f), (0.68, 0x527a32)])
        shade = n.ramp(clumps, [(0.3, 0x2b4c1f), (0.55, 0x44702f), (0.8, 0x58803a)])
        color = n.mix(0.45, base, shade)
        color = n.mix(n.math('MULTIPLY', n.math('SUBTRACT', blades, 0.35, clamp=True), 0.7), color, 0x2c4a20)
        n.link(color, bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 0.95
        terrain.bump(n, bsdf, n.math('ADD', blades, n.math('MULTIPLY', clumps, 0.6)), 0.35, 0.03)

    terrain.ground_plane(PERIOD, terrain.ground_material('grass', wire))


def build_sand(ctx):
    def wire(n, bsdf):
        p = terrain.Periodic(n, PERIOD)
        patches = p.noise(1.5, detail=2.0, offset=4)
        warp = p.noise(0.8, detail=1.0, offset=5)
        ripples = p.waves(17, 7, warp, 4.0)
        grains = p.noise(22.0, detail=1.0, offset=6)
        base = n.ramp(patches, [(0.35, 0xb39f68), (0.5, 0xc0ab74), (0.7, 0xcbb985)])
        color = n.mix(n.math('MULTIPLY', ripples, 0.25), base, 0xa48f5c)
        color = n.mix(n.math('MULTIPLY', n.math('SUBTRACT', grains, 0.55, clamp=True), 1.2), color, 0xe0d0a0)
        n.link(color, bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 0.95
        terrain.bump(n, bsdf, n.math('ADD', ripples, n.math('MULTIPLY', grains, 0.3)), 0.3, 0.02)

    terrain.ground_plane(PERIOD, terrain.ground_material('sand', wire))


def build_water(ctx):
    def wire(n, bsdf):
        p = terrain.Periodic(n, PERIOD)
        depth = p.noise(1.5, detail=2.0, offset=7)
        ripples = p.noise(3.0, detail=3.0, roughness=0.55, distortion=0.6, offset=8)
        color = n.ramp(depth, [(0.35, 0x1f4a70), (0.65, 0x2a5a82)])
        n.link(color, bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 0.18
        bsdf.inputs['Specular IOR Level'].default_value = 0.35
        terrain.bump(n, bsdf, ripples, 0.25, 0.04)

    terrain.ground_plane(PERIOD, terrain.ground_material('water', wire))


def build_rock(ctx):
    def wire(n, bsdf):
        p = terrain.Periodic(n, PERIOD)
        plates = p.voronoi(1.3)
        edges = p.voronoi(1.3, feature='DISTANCE_TO_EDGE')
        grit = p.noise(12.0, detail=3.0, offset=9)
        patches = p.noise(1.6, detail=2.0, offset=10)
        tone = n.ramp(plates.outputs['Color'], [(0.0, 0x625e58), (1.0, 0x7a756d)])
        base = n.mix(n.math('MULTIPLY', patches, 0.5), tone, 0x6b6257)
        crack = n.math('SUBTRACT', 1.0, n.math('MULTIPLY', edges.outputs['Distance'], 14.0), clamp=True)
        color = n.mix(n.math('MULTIPLY', crack, 0.8), base, 0x3e3a35)
        color = n.mix(n.math('MULTIPLY', n.math('SUBTRACT', grit, 0.5, clamp=True), 0.8), color, 0x8c877e)
        n.link(color, bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 0.9
        height = n.math('ADD', n.math('MULTIPLY', edges.outputs['Distance'], 3.0), n.math('MULTIPLY', grit, 0.25))
        terrain.bump(n, bsdf, n.math('MINIMUM', height, 0.6), 0.5, 0.04)

    terrain.ground_plane(PERIOD, terrain.ground_material('rock', wire))


MODELS = [
    {'name': 'grass', 'kind': 'ground', 'atlas': 'terrain', 'period': PERIOD, 'build': build_grass},
    {'name': 'sand', 'kind': 'ground', 'atlas': 'terrain', 'period': PERIOD, 'build': build_sand},
    {'name': 'water', 'kind': 'ground', 'atlas': 'terrain', 'period': PERIOD, 'build': build_water},
    {'name': 'rock', 'kind': 'ground', 'atlas': 'terrain', 'period': PERIOD, 'build': build_rock},
]
