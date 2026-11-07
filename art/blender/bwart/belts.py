"""
Shared geometry of the belt family: the paths items follow over a belt tile
(straight, and the two curves), sheets swept along them, the moving belt
surface with its chevron slats, the side frames in the tier color and the
hoods of underground belts.

Paths match the game's (src/render/beltPath.ts): facing north, items come in
at the south edge (or the west / east edge for a curve) and leave at the
north edge; `lateral` is the distance to the right of the middle line, in
tiles. Belts span the whole tile from edge to edge, so neighbours join up.
"""

import math

import bmesh

from bwart.shapes import _bevel, _mesh_object, box, cylinder, prism

STRAIGHT = 'straight'
CURVE_LEFT = 'curve-left'
CURVE_RIGHT = 'curve-right'
SHAPES = (STRAIGHT, CURVE_LEFT, CURVE_RIGHT)

#: Slats per tile of belt; the belt animation loops over one slat (docs/ART.md).
SLATS = 4
#: Half the width of the moving surface, and where the side frames start and end.
SURFACE_HALF = 0.37
FRAME_IN = 0.375
FRAME_OUT = 0.5
SURFACE_Z = 0.075
SLAT_Z = 0.088
FRAME_Z = 0.12


def point(shape, t, lateral):
    """Model-space (x, y) of progress `t` (0..1) along `shape`, `lateral` tiles right of the middle."""
    if shape == STRAIGHT:
        return (lateral, -0.5 + t)
    a = (1 - t) * math.pi / 2
    if shape == CURVE_LEFT:
        # In from the west edge, around the north-west corner.
        r = 0.5 + lateral
        return (-0.5 + r * math.cos(a), 0.5 - r * math.sin(a))
    # In from the east edge, around the north-east corner.
    r = 0.5 - lateral
    return (0.5 - r * math.cos(a), 0.5 - r * math.sin(a))


def sheet(name, grid, z0, z1, mat):
    """
    A closed slab over `grid` (rows of model-space (x, y) points; rows along
    one axis of the sheet, points along the other) from height z0 to z1.
    """
    bm = bmesh.new()
    rows = len(grid)
    cols = len(grid[0])
    top = [[bm.verts.new((x, y, z1)) for x, y in row] for row in grid]
    bottom = [[bm.verts.new((x, y, z0)) for x, y in row] for row in grid]

    def quad(a, b, c, d):
        try:
            bm.faces.new((a, b, c, d))
        except ValueError:
            pass

    for i in range(rows - 1):
        for j in range(cols - 1):
            quad(top[i][j], top[i][j + 1], top[i + 1][j + 1], top[i + 1][j])
            quad(bottom[i][j], bottom[i + 1][j], bottom[i + 1][j + 1], bottom[i][j + 1])
    for i in range(rows - 1):
        quad(top[i][0], top[i + 1][0], bottom[i + 1][0], bottom[i][0])
        quad(top[i][-1], bottom[i][-1], bottom[i + 1][-1], top[i + 1][-1])
    for j in range(cols - 1):
        quad(top[0][j], bottom[0][j], bottom[0][j + 1], top[0][j + 1])
        quad(top[-1][j], top[-1][j + 1], bottom[-1][j + 1], bottom[-1][j])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _mesh_object(name, bm, (0.0, 0.0, 0.0), (0.0, 0.0, 0.0), mat)


def band(name, shape, lat0, lat1, z0, z1, mat, t0=0.0, t1=1.0, steps=None, lat_steps=1):
    """A slab along `shape` between laterals lat0..lat1 and progress t0..t1."""
    if steps is None:
        steps = 1 if shape == STRAIGHT else 24
    grid = []
    for i in range(steps + 1):
        t = t0 + (t1 - t0) * i / steps
        grid.append([point(shape, t, lat0 + (lat1 - lat0) * j / lat_steps) for j in range(lat_steps + 1)])
    return sheet(name, grid, z0, z1, mat)


def chevron_slats(shape, phase, mat, width=0.55, lead=0.05):
    """
    The slats across the moving surface, `SLATS` per tile, shifted forward by
    `phase` (0..1) of a slat: chevrons pointing the way the belt moves, `width`
    of a slat's pitch wide, the middle `lead` tiles ahead of the edges.
    Slats crossing the tile's edges are cut there (the next tile has the rest).
    """
    pitch = 1.0 / SLATS
    lats = [SURFACE_HALF * (2 * j / 8 - 1) for j in range(9)]
    for i in range(-1, SLATS + 1):
        start = (i + phase) * pitch
        rows = []
        for k in range(4):
            s = start + width * pitch * k / 3
            row = []
            for lat in lats:
                ahead = lead * (1 - abs(lat) / SURFACE_HALF)
                t = min(1.0, max(0.0, s + ahead))
                row.append(point(shape, t, lat))
            rows.append(row)
        # Skip slats entirely outside the tile.
        if start + width * pitch + lead <= 0.0 or start >= 1.0:
            continue
        sheet('slat', rows, SURFACE_Z - 0.004, SLAT_Z, mat)


def surface(shape, phase, rubber, slat):
    """The moving belt: a dark band over the whole tile with slats on it."""
    steps = 1 if shape == STRAIGHT else 32
    band('belt', shape, -SURFACE_HALF - 0.01, SURFACE_HALF + 0.01, 0.02, SURFACE_Z, rubber, steps=steps, lat_steps=4)
    chevron_slats(shape, phase, slat)


def side_frames(shape, paint, dark, steel):
    """
    The static side frames: a channel in the tier color on each side, with a
    dark lip on the inside, a dark foot on the outside and two roller caps.
    Nothing between them: the surface (drawn first) shows through.
    """
    steps = 1 if shape == STRAIGHT else 24
    for side in (-1, 1):
        lo, hi = sorted((side * FRAME_IN, side * FRAME_OUT))
        band('frame', shape, lo, hi, 0.0, FRAME_Z, paint, steps=steps)
        # A darker lip along the top inner edge, and a dark foot outside.
        lip_lo, lip_hi = sorted((side * (FRAME_IN - 0.012), side * (FRAME_IN + 0.02)))
        band('lip', shape, lip_lo, lip_hi, FRAME_Z - 0.03, FRAME_Z + 0.008, dark, steps=steps)
        foot_lo, foot_hi = sorted((side * (FRAME_OUT - 0.035), side * FRAME_OUT))
        band('foot', shape, foot_lo, foot_hi, 0.0, 0.035, dark, steps=steps)
    # Rollers' axle caps on the frames, two per side on a straight belt.
    for t in (0.25, 0.75):
        for side in (-1, 1):
            x, y = point(shape, t, side * (FRAME_OUT - 0.06))
            band_cap(x, y, steel)


def band_cap(x, y, mat):
    cylinder(0.022, 0.012, (x, y, FRAME_Z + 0.004), mat, verts=10)


def side_prism(name, points_yz, x0, x1, mat, bevel=0.0):
    """A polygon in the model's y-z plane (`points_yz`) extruded from x = x0 to x1."""
    bm = bmesh.new()
    left = [bm.verts.new((x0, y, z)) for y, z in points_yz]
    right = [bm.verts.new((x1, y, z)) for y, z in points_yz]
    bm.faces.new(left)
    bm.faces.new(right)
    n = len(points_yz)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((left[i], left[j], right[j], right[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = _mesh_object(name, bm, (0.0, 0.0, 0.0), (0.0, 0.0, 0.0), mat)
    _bevel(obj, bevel)
    return obj


#: Underground hood: height at the mouth, and at its far end.
HOOD_TALL = 0.44
HOOD_LOW = 0.2


def hood(exit_, paint, dark, mouth, steel):
    """
    The hood of an underground belt facing north: over the north half of the
    tile for an entrance (its mouth opens to the south, where items come in,
    and it slopes down to the north, where they go under), over the south
    half for an exit (the mirror image: items come up and leave through the
    mouth on the north side). An arrow on the roof shows the way items go.
    """
    s = -1 if exit_ else 1  # mirror for an exit
    flat = 0.2
    # Side profile (y, z), from the mouth backwards.
    profile = [(0.0, 0.0), (0.5, 0.0), (0.5, HOOD_LOW), (flat, HOOD_TALL), (0.0, HOOD_TALL)]
    side_prism('hood', [(s * y, z) for y, z in profile], -0.5, 0.5, paint, bevel=0.015)
    # The mouth: a dark opening framed in dark iron, just proud of the face.
    face = -0.004 * s
    box((0.76, 0.01, 0.3), (0, face, 0.15), mouth, bevel=0.0)
    box((0.86, 0.03, 0.05), (0, face - 0.01 * s, 0.32), dark, bevel=0.01)
    for sx in (-1, 1):
        box((0.05, 0.03, 0.32), (sx * 0.405, face - 0.01 * s, 0.16), dark, bevel=0.01)
    # Dark skirts along the bottom of both sides, and a seam where the roof bends.
    for sx in (-1, 1):
        box((0.02, 0.5, 0.05), (sx * 0.5, s * 0.25, 0.025), dark, bevel=0.0)
    box((1.0, 0.03, 0.02), (0, s * flat, HOOD_TALL - 0.005), dark, bevel=0.0)
    # The arrow on the flat part of the roof, pointing north (the way items go).
    c = s * flat / 2
    arrow = [(-0.17, c - 0.1), (0.0, c + 0.015), (0.17, c - 0.1), (0.17, c - 0.05), (0.0, c + 0.07), (-0.17, c - 0.05)]
    prism(arrow, 0.012, (0, 0, HOOD_TALL), dark, bevel=0.0)
    # Bolts at the front corners of the roof.
    for sx in (-1, 1):
        cylinder(0.02, 0.012, (sx * 0.42, s * 0.04, HOOD_TALL + 0.004), steel, verts=10)
