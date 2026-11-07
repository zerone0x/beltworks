"""Assembling machine 1 (3x3): olive paint, a three-armed rotor in the work well."""

from bwart import assembler

BODY_H = 0.62

MODEL = {
    'name': 'assembling-machine-1',
    'footprint': (3, 3),
    'height': 1.2,
    'layers': [
        {'name': 'body'},
        {'name': 'rotor', 'frames': 16, 'fps': 16},
    ],
    # Where the game draws the recipe's product icon: over the rotor's hub.
    'points': {'icon': (0.0, 0.0, assembler.icon_height(BODY_H))},
}


def build(ctx):
    assembler.build(ctx, 0x8f8f62, BODY_H, arms=3, tier=1)
