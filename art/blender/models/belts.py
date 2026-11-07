"""
The belt family, every tier (docs/ART.md, "Belts"), in the `logistics` atlas:

- `belt-surface`, `belt-surface:curve-left`, `belt-surface:curve-right`: the
  moving belt with its chevron slats, shared by every tier: 16 frames over
  one slat pitch (a quarter tile). The game picks the frame from how far the
  belt has moved, so the slats run at exactly the items' speed. No shadow:
  it lies flat on the ground.
- `<tier>transport-belt` (straight), `:curve-left`, `:curve-right`: the
  static side frames in the tier color, drawn over the surface.
- `<tier>underground-belt:entrance`, `:exit`: the hood over the closed half
  of an underground belt, drawn over its straight belt and the items on it.

Built facing north; curves come in at the west (`curve-left`) or east
(`curve-right`) edge and leave at the north edge, like the game's
`BeltShape.CurveFromLeft` / `CurveFromRight`.
"""

from bwart import belts
from bwart import materials as m

SURFACE_FRAMES = 16

TIERS = (
    ('transport-belt', 'underground-belt', 'tier_yellow'),
    ('fast-transport-belt', 'fast-underground-belt', 'tier_red'),
    ('express-transport-belt', 'express-underground-belt', 'tier_blue'),
)


def suffix(shape):
    return '' if shape == belts.STRAIGHT else ':' + shape


def surface_model(shape):
    def build(ctx):
        # Plain materials: wear patterns don't show on a moving belt at 1×, and cost atlas bytes.
        rubber = m.plain('belt_rubber', 0x2c2d30, roughness=0.75)
        slat = m.plain('belt_slat', 0x767c83, metallic=0.55, roughness=0.42)
        belts.surface(shape, ctx.t('surface'), rubber, slat)

    return {
        'name': 'belt-surface' + suffix(shape),
        'atlas': 'logistics',
        'footprint': (1, 1),
        'height': 0.1,
        'directions': 4,
        'shadow': False,
        'layers': [{'name': 'surface', 'frames': SURFACE_FRAMES, 'advance': 'never'}],
        'build': build,
    }


def frame_model(belt, color, shape):
    def build(ctx):
        paint = m.paint('belt_paint_' + color, color, amount=0.08)
        belts.side_frames(shape, paint, m.dark_iron(), m.iron())

    return {
        'name': belt + suffix(shape),
        'atlas': 'logistics',
        'footprint': (1, 1),
        'height': 0.14,
        'directions': 4,
        # Its shadow would fall mostly on the belt (under the surface, out of sight) and only
        # costs fill rate: none.
        'shadow': False,
        'layers': [{'name': 'body'}],
        'build': build,
    }


def hood_model(underground, color, exit_):
    def build(ctx):
        paint = m.paint('hood_paint_' + color, color, amount=0.2)
        mouth = m.plain('hood_mouth', 0x141416, roughness=1.0)
        belts.hood(exit_, paint, m.dark_iron(), mouth, m.iron())

    return {
        'name': underground + (':exit' if exit_ else ':entrance'),
        'atlas': 'logistics',
        'footprint': (1, 1),
        'height': belts.HOOD_TALL + 0.02,
        'directions': 4,
        'layers': [{'name': 'body'}],
        'build': build,
    }


MODELS = [surface_model(shape) for shape in belts.SHAPES]
for _belt, _underground, _color in TIERS:
    MODELS += [frame_model(_belt, _color, shape) for shape in belts.SHAPES]
    MODELS += [hood_model(_underground, _color, exit_) for exit_ in (False, True)]
