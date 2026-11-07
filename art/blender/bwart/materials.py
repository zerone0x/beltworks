"""
The material palette: procedural, slightly worn surfaces (no image textures).
Every material is cached by name, so models can ask for the same one twice.

Colors are given as sRGB hex (0xRRGGBB) like the game's prototype colors and
converted to linear here.
"""

import bpy

#: Shared palette (sRGB). Tier colors follow docs/ART.md.
PALETTE = {
    'iron': 0x8a9097,
    'iron_dark': 0x4a4f55,
    'steel': 0xa9b0b8,
    'rust': 0x7a4a2c,
    'brass': 0xc29a4a,
    'copper': 0xc07a4a,
    'wood': 0x9a6a3a,
    'wood_dark': 0x6e4726,
    'stone': 0x9a8f7c,
    'stone_dark': 0x6f6658,
    'soot': 0x1e1b19,
    'rubber': 0x26272a,
    'tier_yellow': 0xd9a62e,
    'tier_red': 0xc0453a,
    'tier_blue': 0x3f7fc8,
    'machine_olive': 0x8f8f68,
    'machine_teal': 0x4f8a7a,
    'hazard': 0xe0b030,
    'glass': 0x9fd0e0,
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgb(hex_color, factor=1.0):
    """A 0xRRGGBB sRGB color as linear RGBA, each channel times `factor`."""
    if isinstance(hex_color, str):
        hex_color = PALETTE[hex_color]
    r = ((hex_color >> 16) & 0xFF) / 255
    g = ((hex_color >> 8) & 0xFF) / 255
    b = (hex_color & 0xFF) / 255
    return (
        srgb_to_linear(r) * factor,
        srgb_to_linear(g) * factor,
        srgb_to_linear(b) * factor,
        1.0,
    )


def _new(name):
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat, False
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    return mat, True


def _noise(nodes, links, scale, detail=4.0, roughness=0.55, stretch=(1.0, 1.0, 1.0)):
    """A noise texture over object coordinates (stable as the model turns), optionally stretched."""
    coords = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = stretch
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = scale
    noise.inputs['Detail'].default_value = detail
    noise.inputs['Roughness'].default_value = roughness
    links.new(coords.outputs['Object'], mapping.inputs['Vector'])
    links.new(mapping.outputs['Vector'], noise.inputs['Vector'])
    return noise


def worn(name, base, wear=None, metallic=0.3, roughness=0.5, amount=0.25, scale=6.0, stretch=(1, 1, 1)):
    """
    A painted or bare surface in `base`, with patches of `wear` (default: a
    darker shade of the base) where a noise pattern peaks, and matching
    roughness variation. `amount` (0..1) is how much of the surface is worn.
    """
    mat, fresh = _new(name)
    if not fresh:
        return mat
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    bsdf.inputs['Metallic'].default_value = metallic
    noise = _noise(nodes, links, scale, stretch=stretch)
    ramp = nodes.new('ShaderNodeValToRGB')
    # Wear shows where the noise is above the threshold.
    lo = 0.62 - 0.25 * amount
    ramp.color_ramp.elements[0].position = lo
    ramp.color_ramp.elements[1].position = lo + 0.12
    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    mix = nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.inputs['A'].default_value = rgb(base)
    mix.inputs['B'].default_value = rgb(wear) if wear is not None else rgb(base, 0.62)
    links.new(ramp.outputs['Color'], mix.inputs['Factor'])
    links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
    rough = nodes.new('ShaderNodeMapRange')
    rough.inputs['To Min'].default_value = roughness
    rough.inputs['To Max'].default_value = min(1.0, roughness + 0.25)
    links.new(ramp.outputs['Color'], rough.inputs['Value'])
    links.new(rough.outputs['Result'], bsdf.inputs['Roughness'])
    return mat


def plain(name, base, metallic=0.0, roughness=0.6):
    """A flat surface with no wear."""
    mat, fresh = _new(name)
    if not fresh:
        return mat
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = rgb(base)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    return mat


def emissive(name, color, strength=4.0):
    """A glowing surface (fire, lamps)."""
    mat, fresh = _new(name)
    if not fresh:
        return mat
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = rgb(color)
    bsdf.inputs['Emission Color'].default_value = rgb(color)
    bsdf.inputs['Emission Strength'].default_value = strength
    bsdf.inputs['Roughness'].default_value = 1.0
    return mat


def iron(name='iron', base='iron'):
    return worn(name, base, wear='rust', metallic=0.45, roughness=0.5, amount=0.15, scale=12.0)


def dark_iron(name='iron_dark'):
    return worn(name, 'iron_dark', wear=0x3a3e43, metallic=0.4, roughness=0.5, amount=0.2, scale=16.0)


def paint(name, base, amount=0.18):
    """Painted steel; worn patches show darker bare metal."""
    return worn(name, base, wear=0x5a5650, metallic=0.15, roughness=0.42, amount=amount, scale=11.0)


def wood(name='wood', base='wood'):
    """Planks: grain along X (rotate the plank, not the texture)."""
    return worn(
        name,
        base,
        wear='wood_dark',
        metallic=0.0,
        roughness=0.75,
        amount=0.55,
        scale=3.0,
        stretch=(0.6, 9.0, 9.0),
    )


def stone(name='stone', base='stone'):
    return worn(name, base, wear='stone_dark', metallic=0.0, roughness=0.9, amount=0.5, scale=4.0)
