"""
Geometry helpers for models. Every object made here is parented to the
model's root (which the driver turns to face each direction) and tagged with
the current sprite layer (see `layer`), so the driver can render each layer
on its own.
"""

import math
from contextlib import contextmanager

import bmesh
import bpy
from mathutils import Matrix, Vector

_state = {'layer': 'body', 'root': None}


def root():
    """The model's root empty (created on first use)."""
    if _state['root'] is None or _state['root'].name not in bpy.data.objects:
        empty = bpy.data.objects.new('model', None)
        bpy.context.scene.collection.objects.link(empty)
        _state['root'] = empty
    return _state['root']


def reset():
    _state['layer'] = 'body'
    _state['root'] = None


@contextmanager
def layer(name):
    """Objects created inside the block belong to sprite layer `name`."""
    previous = _state['layer']
    _state['layer'] = name
    try:
        yield
    finally:
        _state['layer'] = previous


def _adopt(obj, mat):
    obj['bw_layer'] = _state['layer']
    obj.parent = root()
    if mat is not None:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    return obj


def _bevel(obj, width, segments=2):
    if width <= 0:
        return
    mod = obj.modifiers.new('bevel', 'BEVEL')
    mod.width = width
    mod.segments = segments
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(40)
    mod.harden_normals = False


def _smooth_sides(obj):
    """Smooth-shades faces whose normals are not along local Z (cylinder sides)."""
    for poly in obj.data.polygons:
        poly.use_smooth = abs(poly.normal.z) < 0.7


def _mesh_object(name, bm, loc, rot, mat):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = rot
    return _adopt(obj, mat)


def box(size, loc, mat, bevel=0.02, rot=(0.0, 0.0, 0.0), name='box'):
    """A box of `size` (x, y, z) centered on `loc`."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    obj = _mesh_object(name, bm, loc, rot, mat)
    _bevel(obj, min(bevel, min(size) * 0.45))
    return obj


def cylinder(radius, depth, loc, mat, rot=(0.0, 0.0, 0.0), verts=24, bevel=0.0, name='cyl', radius2=None):
    """A cylinder (or with `radius2` a truncated cone) along local Z, centered on `loc`."""
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=verts,
        radius1=radius,
        radius2=radius if radius2 is None else radius2,
        depth=depth,
    )
    obj = _mesh_object(name, bm, loc, rot, mat)
    _smooth_sides(obj)
    _bevel(obj, bevel)
    return obj


def sphere(radius, loc, mat, segments=16, name='sphere', scale=(1.0, 1.0, 1.0)):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=segments // 2, radius=radius)
    obj = _mesh_object(name, bm, loc, (0.0, 0.0, 0.0), mat)
    obj.scale = scale
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def prism(points, depth, loc, mat, rot=(0.0, 0.0, 0.0), bevel=0.0, name='prism'):
    """A convex or concave polygon `points` ((x, y) in local XY) extruded `depth` up from `loc`."""
    bm = bmesh.new()
    verts = [bm.verts.new((x, y, 0.0)) for x, y in points]
    face = bm.faces.new(verts)
    if face.normal.z < 0:
        face.normal_flip()
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    top = [v for v in ext['geom'] if isinstance(v, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0.0, 0.0, depth), verts=top)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = _mesh_object(name, bm, loc, rot, mat)
    _bevel(obj, bevel)
    return obj


def gear(radius, teeth, depth, loc, mat, rot=(0.0, 0.0, 0.0), tooth=0.18, phase=0.0, name='gear'):
    """
    A spur gear along local Z, centered on `loc`: `teeth` teeth of `tooth` x
    radius height, turned by `phase` (radians).
    """
    inner = radius * (1.0 - tooth)
    points = []
    steps = teeth * 4
    for i in range(steps):
        a = phase + 2 * math.pi * (i + 0.5) / steps
        r = radius if (i % 4) in (1, 2) else inner
        points.append((math.cos(a) * r, math.sin(a) * r))
    obj = prism(points, depth, loc, mat, rot=rot, bevel=min(0.01, depth * 0.3), name=name)
    obj.data.transform(Matrix.Translation((0.0, 0.0, -depth / 2)))
    return obj


def torus(major, minor, loc, mat, rot=(0.0, 0.0, 0.0), name='torus', major_segments=32, minor_segments=8):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major,
        minor_radius=minor,
        major_segments=major_segments,
        minor_segments=minor_segments,
        location=loc,
        rotation=rot,
    )
    obj = bpy.context.active_object
    obj.name = name
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return _adopt(obj, mat)


def pipe(points, radius, mat, name='pipe', verts=12):
    """A tube through `points` (3D) with round joints."""
    objs = []
    for a, b in zip(points, points[1:]):
        a, b = Vector(a), Vector(b)
        mid = (a + b) / 2
        d = b - a
        rot = d.to_track_quat('Z', 'Y').to_euler()
        objs.append(cylinder(radius, d.length, mid, mat, rot=rot, verts=verts, name=name))
    for p in points[1:-1]:
        objs.append(sphere(radius, p, mat, segments=verts, name=name + '_joint'))
    return objs
