"""
Helpers for the terrain models: seamless (periodic) procedural ground
materials, rocks, foliage blobs and soft-edged ground stains.

Seamless ground: Blender's noise isn't periodic, but its 4D variants are
smooth functions of four coordinates, so a ground of period P tiles maps
(x, y) onto two circles, (R cos 2πx/P, R sin 2πx/P, R cos 2πy/P, R sin
2πy/P) with R = P / 2π (a flat torus, so distances barely change), and
samples the 4D noise there: the texture repeats exactly every P tiles in
both directions while one noise unit stays about one tile.
"""

import math
import random

import bmesh
import bpy
from mathutils import Vector, noise

from bwart import materials as m
from bwart.shapes import _mesh_object

TAU = 2 * math.pi


class Nodes:
    """A small builder over a material's node tree."""

    def __init__(self, mat):
        self.mat = mat
        self.nodes = mat.node_tree.nodes
        self.links = mat.node_tree.links

    def new(self, kind, **inputs):
        node = self.nodes.new(kind)
        for key, value in inputs.items():
            if hasattr(value, 'is_output') or isinstance(value, bpy.types.NodeSocket):
                self.links.new(value, node.inputs[key])
            else:
                node.inputs[key].default_value = value
        return node

    def link(self, a, b):
        self.links.new(a, b)

    def math(self, op, a, b=0.0, c=None, clamp=False):
        node = self.nodes.new('ShaderNodeMath')
        node.operation = op
        node.use_clamp = clamp
        for i, v in enumerate((a, b) if c is None else (a, b, c)):
            if isinstance(v, bpy.types.NodeSocket):
                self.links.new(v, node.inputs[i])
            else:
                node.inputs[i].default_value = v
        return node.outputs[0]

    def ramp(self, fac, stops):
        """A color ramp over `fac` with `stops` = [(position, 0xRRGGBB or (r, g, b, a) linear)]."""
        node = self.nodes.new('ShaderNodeValToRGB')
        self.links.new(fac, node.inputs['Fac'])
        elements = node.color_ramp.elements
        while len(elements) < len(stops):
            elements.new(0.5)
        for el, (pos, color) in zip(elements, stops):
            el.position = pos
            el.color = m.rgb(color) if isinstance(color, int) else color
        return node.outputs['Color']

    def mix(self, factor, a, b, blend='MIX'):
        node = self.nodes.new('ShaderNodeMix')
        node.data_type = 'RGBA'
        node.blend_type = blend
        for key, v in (('Factor', factor), ('A', a), ('B', b)):
            if isinstance(v, bpy.types.NodeSocket):
                self.links.new(v, node.inputs[key])
            elif isinstance(v, int):
                node.inputs[key].default_value = m.rgb(v)
            else:
                node.inputs[key].default_value = v
        return node.outputs['Result']


class Periodic:
    """4D coordinates of a ground with period `period` tiles (see the module doc)."""

    def __init__(self, n, period):
        self.n = n
        self.period = period
        coords = n.new('ShaderNodeTexCoord')
        sep = n.new('ShaderNodeSeparateXYZ', Vector=coords.outputs['Object'])
        self.x = sep.outputs['X']
        self.y = sep.outputs['Y']
        r = period / TAU
        k = TAU / period
        ax = n.math('MULTIPLY', self.x, k)
        ay = n.math('MULTIPLY', self.y, k)
        cx = n.math('MULTIPLY', n.math('COSINE', ax), r)
        sx = n.math('MULTIPLY', n.math('SINE', ax), r)
        cy = n.math('MULTIPLY', n.math('COSINE', ay), r)
        sy = n.math('MULTIPLY', n.math('SINE', ay), r)
        combine = n.new('ShaderNodeCombineXYZ', X=cx, Y=sx, Z=cy)
        self.vector = combine.outputs['Vector']
        self.w = sy

    def noise(self, scale, detail=3.0, roughness=0.5, distortion=0.0, offset=0.0):
        """Periodic noise (`Fac` output, ~0.5 average) with about `scale` features per tile."""
        n = self.n
        node = n.nodes.new('ShaderNodeTexNoise')
        node.noise_dimensions = '4D'
        n.link(self.vector, node.inputs['Vector'])
        n.link(n.math('ADD', self.w, offset * 7.31), node.inputs['W'])
        node.inputs['Scale'].default_value = scale
        node.inputs['Detail'].default_value = detail
        node.inputs['Roughness'].default_value = roughness
        node.inputs['Distortion'].default_value = distortion
        return node.outputs['Fac']

    def voronoi(self, scale, feature='F1', randomness=1.0):
        n = self.n
        node = n.nodes.new('ShaderNodeTexVoronoi')
        node.voronoi_dimensions = '4D'
        node.feature = feature
        n.link(self.vector, node.inputs['Vector'])
        n.link(self.w, node.inputs['W'])
        node.inputs['Scale'].default_value = scale
        node.inputs['Randomness'].default_value = randomness
        return node

    def waves(self, nx, ny, warp=None, warp_amount=0.0):
        """sin(2π (nx x + ny y) / period + warp): stripes that repeat (whole waves per period)."""
        n = self.n
        k = TAU / self.period
        phase = n.math('ADD', n.math('MULTIPLY', self.x, nx * k), n.math('MULTIPLY', self.y, ny * k))
        if warp is not None:
            phase = n.math('ADD', phase, n.math('MULTIPLY', warp, warp_amount))
        return n.math('MULTIPLY_ADD', n.math('SINE', phase), 0.5, 0.5)


def ground_plane(period, mat):
    """A flat plane covering the period with a margin (the camera sees exactly the period)."""
    bpy.ops.mesh.primitive_plane_add(size=period + 4, location=(0.0, 0.0, 0.0))
    plane = bpy.context.active_object
    plane.name = 'ground'
    plane.data.materials.append(mat)
    plane['bw_layer'] = 'body'
    return plane


def ground_material(name, build):
    """A material whose base color, roughness and bump `build(n, bsdf)` wires up."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    n = Nodes(mat)
    bsdf = n.nodes['Principled BSDF']
    build(n, bsdf)
    return mat


def bump(n, bsdf, height, strength, distance=0.02):
    node = n.new('ShaderNodeBump', Strength=strength, Distance=distance, Height=height)
    n.link(node.outputs['Normal'], bsdf.inputs['Normal'])


def rock_mesh(name, radius, loc, mat, rng, squash=0.6, rough=0.35, subdivisions=2, rot_z=None):
    """An irregular rock: an icosphere pushed in and out by noise, flattened to `squash`."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=1.0)
    seed = Vector((rng.uniform(-100, 100), rng.uniform(-100, 100), rng.uniform(-100, 100)))
    for v in bm.verts:
        d = 1.0 + rough * noise.noise(v.co * 1.3 + seed) + 0.12 * noise.noise(v.co * 3.1 + seed)
        # Facets: flatten a little towards a few planes for a chipped look.
        v.co = v.co * d
        v.co.z *= squash
    bmesh.ops.scale(bm, vec=(radius, radius, radius), verts=bm.verts)
    lowest = min(v.co.z for v in bm.verts)
    bmesh.ops.translate(bm, vec=(0.0, 0.0, -lowest * 0.75), verts=bm.verts)
    rz = rng.uniform(0, TAU) if rot_z is None else rot_z
    obj = _mesh_object(name, bm, loc, (0.0, 0.0, rz), mat)
    for poly in obj.data.polygons:
        poly.use_smooth = False
    return obj


def blob(name, radius, loc, mat, seed, lumps=0.22, scale=(1.0, 1.0, 1.0), subdivisions=3):
    """A lumpy round mass (a clump of foliage): an icosphere displaced by noise, smooth shaded."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=1.0)
    s = Vector(seed)
    for v in bm.verts:
        d = 1.0 + lumps * noise.noise(v.co * 2.2 + s) + lumps * 0.5 * noise.noise(v.co * 5.0 + s)
        v.co = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2])) * d
    bmesh.ops.scale(bm, vec=(radius, radius, radius), verts=bm.verts)
    obj = _mesh_object(name, bm, loc, (0.0, 0.0, 0.0), mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def foliage(name, base, dark, light, scale=9.0):
    """Leaves: clumps of light and dark green over object coordinates, matte."""
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    n = Nodes(mat)
    bsdf = n.nodes['Principled BSDF']
    coords = n.new('ShaderNodeTexCoord')
    tex = n.nodes.new('ShaderNodeTexNoise')
    n.link(coords.outputs['Object'], tex.inputs['Vector'])
    tex.inputs['Scale'].default_value = scale
    tex.inputs['Detail'].default_value = 4.0
    tex.inputs['Roughness'].default_value = 0.6
    color = n.ramp(tex.outputs['Fac'], [(0.3, dark), (0.5, base), (0.72, light)])
    n.link(color, bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.85
    bump(n, bsdf, tex.outputs['Fac'], 0.6, 0.05)
    return mat


def stain(name, color, radius, softness, alpha=0.8):
    """
    A flat ground stain: `color` at `alpha` in the middle, fading out between
    `radius - softness` and `radius` (object units) from the object's origin.
    """
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.blend_method = 'BLEND'
    n = Nodes(mat)
    out = n.nodes['Material Output']
    bsdf = n.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = m.rgb(color)
    bsdf.inputs['Roughness'].default_value = 1.0
    coords = n.new('ShaderNodeTexCoord')
    sep = n.new('ShaderNodeSeparateXYZ', Vector=coords.outputs['Object'])
    tex = n.nodes.new('ShaderNodeTexNoise')
    n.link(coords.outputs['Object'], tex.inputs['Vector'])
    tex.inputs['Scale'].default_value = 5.0
    # A rounded square distance, wobbled by noise, so stains of neighbours merge into a patch.
    ax = n.math('POWER', n.math('ABSOLUTE', sep.outputs['X']), 4.0)
    ay = n.math('POWER', n.math('ABSOLUTE', sep.outputs['Y']), 4.0)
    d = n.math('POWER', n.math('ADD', ax, ay), 0.25)
    d = n.math('ADD', d, n.math('MULTIPLY', n.math('SUBTRACT', tex.outputs['Fac'], 0.5), softness * 1.2))
    edge = n.new('ShaderNodeMapRange', Value=d, **{'From Min': radius - softness, 'From Max': radius, 'To Min': alpha, 'To Max': 0.0})
    edge.clamp = True
    transparent = n.nodes.new('ShaderNodeBsdfTransparent')
    mix = n.nodes.new('ShaderNodeMixShader')
    n.link(edge.outputs['Result'], mix.inputs['Fac'])
    n.link(transparent.outputs[0], mix.inputs[1])
    n.link(bsdf.outputs[0], mix.inputs[2])
    n.link(mix.outputs[0], out.inputs['Surface'])
    return mat


def seeded(*parts):
    """A random generator seeded from `parts` (stable across runs and Python versions)."""
    text = '/'.join(str(p) for p in parts)
    h = 2166136261
    for ch in text.encode():
        h = ((h ^ ch) * 16777619) & 0xFFFFFFFF
    return random.Random(h)
