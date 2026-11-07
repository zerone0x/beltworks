"""Iron chest (1x1): a riveted steel box with a flat panelled lid, banding and side handles."""

from bwart import materials as m
from bwart.shapes import box, cylinder, sphere

MODEL = {
    'name': 'iron-chest',
    'footprint': (1, 1),
    'height': 0.75,
    'layers': [{'name': 'body'}],
}

W, D, H = 0.84, 0.68, 0.52


def build(ctx):
    steel = m.worn('chest_steel', 0x75808d, wear=0x4d535b, metallic=0.5, roughness=0.42, amount=0.25, scale=6.0)
    band = m.dark_iron()
    seam = m.plain('chest_seam', 0x1b1d20, roughness=0.8)
    rivet = m.worn('rivet', 0xc3cad2, metallic=0.8, roughness=0.3, amount=0.1)

    box((W, D, H - 0.1), (0, 0, (H - 0.1) / 2), steel, bevel=0.03)
    # A dark seam, then the lid with a raised panel.
    box((W - 0.03, D - 0.03, 0.03), (0, 0, H - 0.085), seam, bevel=0.0)
    box((W + 0.02, D + 0.02, 0.09), (0, 0, H - 0.03), steel, bevel=0.03)
    box((W - 0.2, D - 0.2, 0.05), (0, 0, H + 0.02), steel, bevel=0.02)
    # Bands around the body and the corners.
    box((W + 0.02, D + 0.02, 0.07), (0, 0, 0.16), band, bevel=0.015)
    for sx in (-1, 1):
        for sy in (-1, 1):
            box((0.08, 0.08, H - 0.1), (sx * (W / 2 - 0.025), sy * (D / 2 - 0.025), (H - 0.1) / 2), band, bevel=0.015)
    # Rivets along the front band, and handles on the sides.
    for i in range(5):
        x = -W / 2 + 0.12 + i * (W - 0.24) / 4
        sphere(0.018, (x, -D / 2 - 0.012, 0.16), rivet, segments=8)
    for sx in (-1, 1):
        cylinder(0.025, 0.24, (sx * (W / 2 + 0.045), 0, 0.32), band, rot=(1.5708, 0, 0), verts=10)
        for sy in (-1, 1):
            box((0.05, 0.03, 0.05), (sx * (W / 2 + 0.025), sy * 0.11, 0.32), band, bevel=0.01)
    # A lock plate at the front.
    box((0.14, 0.03, 0.12), (0, -D / 2 - 0.02, H - 0.1), m.worn('lock', 'brass', metallic=0.6, roughness=0.35, amount=0.1), bevel=0.012)
