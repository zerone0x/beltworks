"""Assembling machine 2 (3x3): teal paint, taller, twin stacks, lamps on the pillars, a four-armed rotor."""

from bwart import assembler

BODY_H = 0.72

MODEL = {
    'name': 'assembling-machine-2',
    'footprint': (3, 3),
    'height': 1.4,
    'layers': [
        {'name': 'body'},
        {'name': 'rotor', 'frames': 16, 'fps': 24},
    ],
    'points': {'icon': (0.0, 0.0, assembler.icon_height(BODY_H))},
}


def build(ctx):
    assembler.build(ctx, 0x4c8a7c, BODY_H, arms=4, tier=2)
