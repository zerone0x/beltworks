"""
The shared sprite scene: render settings, camera, lights, world and the
ground, identical for every model so all sprites match (docs/ART.md).

Units: one Blender unit is one tile. A model stands on the ground (z = 0)
with its footprint centered on the origin; +Y is north (away from the
camera), +X east. Models are authored facing north; the driver turns them
for the other directions.

Projection: an orthographic camera looks down at CAMERA_ELEVATION from the
south. The game's grid is square on screen, so the image is stretched
vertically by 1 / sin(elevation) through the pixel aspect ratio: a tile of
ground covers exactly TILE_PX x TILE_PX pixels, and a height of 1 tile shows
as HEIGHT_ON_SCREEN tiles.
"""

import math

import bpy
from mathutils import Vector

#: Texels per tile in the sprites (the game draws a tile as 32 world pixels, so 2x zoom stays sharp).
TILE_PX = 64
CAMERA_ELEVATION = math.radians(50)
#: How tall 1 tile of height looks on screen, in tiles (cot of the elevation).
HEIGHT_ON_SCREEN = math.cos(CAMERA_ELEVATION) / math.sin(CAMERA_ELEVATION)
#: Where the key light comes from: up and to the west, slightly north (shadows fall to the lower right).
SUN_FROM = Vector((-1.0, 0.45, 1.25)).normalized()
SUN_COLOR = (1.0, 0.9, 0.76)
SUN_STRENGTH = 3.6
#: Soft sky fill, a little blue.
SKY_COLOR = (0.62, 0.70, 0.82)
SKY_STRENGTH = 0.85
#: The ground's color for bounce light (dry grass, darkish).
GROUND_COLOR = (0.16, 0.17, 0.11)


def clear():
    """Removes every object and data block, so each render starts from nothing."""
    for collection in (
        bpy.data.objects,
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.lights,
        bpy.data.cameras,
        bpy.data.worlds,
        bpy.data.node_groups,
        bpy.data.images,
    ):
        for block in list(collection):
            collection.remove(block)


def setup_render(width, height, samples):
    """Cycles on the CPU with fixed samples and seed, transparent film, plain sRGB output."""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    cycles = scene.cycles
    cycles.device = 'CPU'
    cycles.samples = samples
    cycles.use_adaptive_sampling = False
    # OpenImageDenoise on the CPU: deterministic (no random input), and smooth
    # surfaces compress far better than sampling noise.
    cycles.use_denoising = True
    cycles.denoiser = 'OPENIMAGEDENOISE'
    cycles.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
    cycles.denoising_prefilter = 'ACCURATE'
    cycles.denoising_quality = 'HIGH'
    cycles.denoising_use_gpu = False
    cycles.seed = 0
    cycles.use_animated_seed = False
    cycles.max_bounces = 4
    cycles.diffuse_bounces = 2
    cycles.glossy_bounces = 2
    cycles.transmission_bounces = 2
    cycles.transparent_max_bounces = 4
    cycles.volume_bounces = 0
    cycles.caustics_reflective = False
    cycles.caustics_refractive = False
    cycles.sample_clamp_indirect = 3.0
    cycles.pixel_filter_type = 'BLACKMAN_HARRIS'
    cycles.filter_width = 1.5
    render = scene.render
    render.film_transparent = True
    render.resolution_x = width
    render.resolution_y = height
    render.resolution_percentage = 100
    # Non-square pixels stretch the image vertically so ground tiles come out square.
    render.pixel_aspect_x = 1.0 / math.sin(CAMERA_ELEVATION)
    render.pixel_aspect_y = 1.0
    render.dither_intensity = 0.0
    render.use_persistent_data = False
    render.image_settings.file_format = 'PNG'
    render.image_settings.color_mode = 'RGBA'
    render.image_settings.color_depth = '8'
    render.image_settings.compression = 15
    settings = scene.view_settings
    settings.view_transform = 'Standard'
    settings.look = 'None'
    settings.exposure = 0.0
    settings.gamma = 1.0
    scene.display_settings.display_device = 'sRGB'
    scene.sequencer_colorspace_settings.name = 'sRGB'


def setup_camera(bounds):
    """
    An orthographic camera whose image covers `bounds`, (left, top, right,
    bottom) in screen tiles relative to the projected origin (y down).
    """
    left, top, right, bottom = bounds
    data = bpy.data.cameras.new('camera')
    data.type = 'ORTHO'
    data.sensor_fit = 'HORIZONTAL'
    data.ortho_scale = right - left
    data.clip_start = 0.1
    data.clip_end = 100.0
    cam = bpy.data.objects.new('camera', data)
    bpy.context.scene.collection.objects.link(cam)
    cam.rotation_euler = (math.pi / 2 - CAMERA_ELEVATION, 0.0, 0.0)
    # Back along the view direction, then across the image plane to center the bounds.
    view_back = Vector((0.0, -math.cos(CAMERA_ELEVATION), math.sin(CAMERA_ELEVATION)))
    image_up = Vector((0.0, math.sin(CAMERA_ELEVATION), math.cos(CAMERA_ELEVATION)))
    cx = (left + right) / 2
    cy = (top + bottom) / 2
    # One screen tile vertically is sin(elevation) units of the image plane (the stretch).
    cam.location = (
        view_back * 30.0
        + Vector((cx, 0.0, 0.0))
        - image_up * (cy * math.sin(CAMERA_ELEVATION))
    )
    bpy.context.scene.camera = cam
    return cam


def setup_lights():
    """The warm key light from the upper left, and the sky."""
    sun_data = bpy.data.lights.new('sun', 'SUN')
    sun_data.energy = SUN_STRENGTH
    sun_data.color = SUN_COLOR
    sun_data.angle = math.radians(4.0)
    sun = bpy.data.objects.new('sun', sun_data)
    bpy.context.scene.collection.objects.link(sun)
    sun.rotation_euler = SUN_FROM.to_track_quat('Z', 'Y').to_euler()

    world = bpy.data.worlds.new('sky')
    world.use_nodes = True
    background = world.node_tree.nodes['Background']
    background.inputs['Color'].default_value = (*SKY_COLOR, 1.0)
    background.inputs['Strength'].default_value = SKY_STRENGTH
    bpy.context.scene.world = world


def add_ground(shadow_catcher):
    """
    The ground plane. Hidden from the camera; it bounces light onto the
    model's lower parts, or with `shadow_catcher` catches the shadow pass.
    """
    bpy.ops.mesh.primitive_plane_add(size=40.0, location=(0.0, 0.0, 0.0))
    ground = bpy.context.active_object
    ground.name = 'ground'
    mat = bpy.data.materials.new('ground')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*GROUND_COLOR, 1.0)
    bsdf.inputs['Roughness'].default_value = 1.0
    ground.data.materials.append(mat)
    ground['bw_layer'] = '__ground'
    if shadow_catcher:
        ground.is_shadow_catcher = True
    else:
        ground.visible_camera = False
    return ground


def screen_bounds(footprint, height, margin=0.25, shadow=True):
    """
    The part of the screen a model of `footprint` (w, h tiles) up to `height`
    tiles tall can cover, with its shadow: (left, top, right, bottom) in
    screen tiles around the projected origin, snapped outwards to whole
    pairs of texels (so the origin lands on an even texel).
    """
    w, h = footprint
    up = height * HEIGHT_ON_SCREEN
    reach = height * 1.6 if shadow else 0.0
    left = -w / 2 - margin
    right = w / 2 + margin + reach
    top = -h / 2 - up - margin
    bottom = h / 2 + margin + reach * 0.45
    step = 2 / TILE_PX
    snap_down = lambda v: math.floor(v / step) * step  # noqa: E731
    snap_up = lambda v: math.ceil(v / step) * step  # noqa: E731
    return (snap_down(left), snap_down(top), snap_up(right), snap_up(bottom))
