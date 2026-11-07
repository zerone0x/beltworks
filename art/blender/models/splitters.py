"""
The splitters, every tier (docs/ART.md, "Splitters"), in the `logistics`
atlas: `splitter`, `fast-splitter`, `express-splitter`.

A splitter is 2 tiles across the way items move and 1 along it. The game
draws each half as a straight belt (the shared `belt-surface` and the tier's
side frames, src/render/beltLayer.ts), so this model is only what stands
over them: a gantry across the middle of both halves in the tier color,
which the items pass under, on three legs (the outer sides and a divider
between the halves, which runs the whole tile), with a dark slot over each
half on both faces and an arrow on top of each half. Drawn over the items
on belts, like an underground belt's hood.

Built facing north (items move to +Y), footprint centered on the origin:
x from -1 to 1, y from -0.5 to 0.5.
"""

from bwart import materials as m
from bwart.shapes import box, cylinder, prism

TIERS = (
    ('splitter', 'tier_yellow'),
    ('fast-splitter', 'tier_red'),
    ('express-splitter', 'tier_blue'),
)

#: The gantry: half its depth along the belts, its underside and its top.
BEAM_HALF = 0.2
BEAM_LOW = 0.17
BEAM_TOP = 0.38


def build_splitter(paint, dark, steel, slot):
    beam_h = BEAM_TOP - BEAM_LOW
    # The gantry across both halves, in the tier color.
    box((1.98, 2 * BEAM_HALF, beam_h), (0, 0, BEAM_LOW + beam_h / 2), paint, bevel=0.03)
    # A dark band along its bottom edges on both faces.
    for sy in (-1, 1):
        box((1.96, 0.02, 0.04), (0, sy * BEAM_HALF, BEAM_LOW + 0.02), dark, bevel=0.0)
    # Legs on the outer sides, and the divider between the halves, the whole tile long.
    for sx in (-1, 1):
        box((0.07, 2 * BEAM_HALF + 0.04, BEAM_LOW), (sx * 0.955, 0, BEAM_LOW / 2), dark, bevel=0.012)
        box((0.05, 0.36, 0.035), (sx * 0.955, 0, 0.0175), dark, bevel=0.008)
    box((0.05, 0.98, 0.13), (0, 0, 0.065), dark, bevel=0.012)
    box((0.07, 2 * BEAM_HALF + 0.04, BEAM_LOW), (0, 0, BEAM_LOW / 2), dark, bevel=0.012)
    # A dark slot over each half on both faces, where the belts run under.
    for sx in (-0.5, 0.5):
        for sy in (-1, 1):
            box((0.62, 0.012, 0.08), (sx, sy * (BEAM_HALF + 0.004), BEAM_LOW + 0.085), slot, bevel=0.0)
    # An arrow on top of each half, pointing north (the way items go).
    for sx in (-0.5, 0.5):
        arrow = [
            (sx - 0.16, -0.07),
            (sx, 0.06),
            (sx + 0.16, -0.07),
            (sx + 0.16, -0.02),
            (sx, 0.115),
            (sx - 0.16, -0.02),
        ]
        prism(arrow, 0.012, (0, 0, BEAM_TOP), dark, bevel=0.0)
    # Bolts along the top, at the ends and over the divider.
    for x in (-0.9, 0.0, 0.9):
        for sy in (-1, 1):
            cylinder(0.022, 0.012, (x, sy * 0.1, BEAM_TOP + 0.004), steel, verts=10)


def splitter_model(name, color):
    def build(ctx):
        paint = m.paint('splitter_paint_' + color, color, amount=0.16)
        slot = m.plain('splitter_slot', 0x141416, roughness=1.0)
        build_splitter(paint, m.dark_iron(), m.iron(), slot)

    return {
        'name': name,
        'atlas': 'logistics',
        'footprint': (2, 1),
        'height': BEAM_TOP + 0.03,
        'directions': 4,
        'layers': [{'name': 'body'}],
        'build': build,
    }


MODELS = [splitter_model(name, color) for name, color in TIERS]
