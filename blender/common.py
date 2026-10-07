"""Shared helpers for the desktop-roomba Blender build scripts.

Conventions (Blender space, before export):
  - metres, floor plane is z = 0, model centre at the origin
  - +Y is the FRONT of the model.  The glTF exporter converts (x, y, z) -> (x, z, -y),
    so in glTF / three.js the front is -Z, up is +Y, right-hand side is +X.
Run headless:  blender -b -P blender/roomba.py
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODELS = os.path.join(ROOT, "public", "models")


# --------------------------------------------------------------------------- scene
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    return scene


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def set_active(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


# --------------------------------------------------------------------------- profiles
def arc(cx, cz, r, a0, a1, n=6):
    """Points of a circular arc in (radius, height) profile space, angles in degrees."""
    return [
        (cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
         cz + r * math.sin(math.radians(a0 + (a1 - a0) * i / n)))
        for i in range(n + 1)
    ]


def rounded_rect_profile(r0, r1, z0, z1, f, n=4):
    """Closed (r, z) loop of a rectangle with filleted corners (for rings / tyres)."""
    f = min(f, (r1 - r0) / 2.0 - 1e-5, (z1 - z0) / 2.0 - 1e-5)
    pts = []
    pts += arc(r1 - f, z1 - f, f, 0, 90, n)       # top outer
    pts += arc(r0 + f, z1 - f, f, 90, 180, n)     # top inner
    pts += arc(r0 + f, z0 + f, f, 180, 270, n)    # bottom inner
    pts += arc(r1 - f, z0 + f, f, 270, 360, n)    # bottom outer
    return pts


# --------------------------------------------------------------------------- mesh building
def revolve(name, profile, segments=96, axis="Z", angle=360.0, start=0.0,
            closed_profile=False, radius_fn=None, materials=None, mat_fn=None,
            smooth_angle=30.0):
    """Lathe an (r, h) profile around an axis.  Open profiles should start and end on the
    axis (r = 0) so the result is a closed solid.  Partial sweeps of closed profiles get caps."""
    bm = bmesh.new()
    full = abs(angle - 360.0) < 1e-6
    nring = segments if full else segments + 1
    rings = []
    for i in range(nring):
        th = math.radians(start + angle * i / segments)
        c, s = math.cos(th), math.sin(th)
        ring = []
        for j, (r, h) in enumerate(profile):
            rr = radius_fn(i, j, r, h) if radius_fn else r
            if axis == "Z":
                co = (rr * c, rr * s, h)
            elif axis == "X":
                co = (h, rr * c, rr * s)
            else:  # Y
                co = (rr * s, h, rr * c)
            ring.append(bm.verts.new(co))
        rings.append(ring)
    npts = len(profile)
    for i in range(segments):
        a, b = rings[i], rings[(i + 1) % nring]
        for j in (range(npts) if closed_profile else range(npts - 1)):
            j2 = (j + 1) % npts
            try:
                bm.faces.new([a[j], b[j], b[j2], a[j2]])
            except ValueError:
                pass
    if not full and closed_profile:
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = link(bpy.data.objects.new(name, me))
    if materials:
        for m in materials:
            me.materials.append(m)
        if mat_fn:
            for p in me.polygons:
                p.material_index = mat_fn(p.center)
    smooth(obj, smooth_angle)
    return obj


def box(name, size, loc=(0, 0, 0), bevel=0.0, segments=3, material=None, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.name = obj.data.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(40)
        mod.harden_normals = False
    if material:
        obj.data.materials.append(material)
    smooth(obj, 30)
    return obj


def cylinder(name, radius, depth, verts=16, loc=(0, 0, 0), rot=(0, 0, 0), material=None):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth,
                                        location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.name = obj.data.name = name
    if material:
        obj.data.materials.append(material)
    smooth(obj, 40)
    return obj


def smooth(obj, angle_deg=30.0):
    """Smooth shading with edges sharper than angle marked sharp (Blender >= 4.1 honours
    the sharp_edge attribute directly, and the glTF exporter writes the split normals)."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    for f in bm.faces:
        f.smooth = True
    lim = math.radians(angle_deg)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim:
            e.smooth = False
        elif len(e.link_faces) == 2:
            e.smooth = True
    bm.to_mesh(me)
    bm.free()


def apply_modifiers(obj):
    set_active(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def join(name, objs, origin=(0, 0, 0)):
    """Join objects into one mesh named `name` whose origin sits at `origin` (world)."""
    for o in objs:
        apply_modifiers(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = obj.data.name = name
    set_origin(obj, origin)
    return obj


def set_origin(obj, origin):
    """Move the object's origin to a world position without moving the geometry."""
    origin = Vector(origin)
    mw = obj.matrix_world.copy()
    delta_local = mw.inverted() @ origin
    obj.data.transform(mw)                      # bake current transform into mesh
    obj.data.transform(__import__("mathutils").Matrix.Translation(-origin))
    obj.matrix_world = __import__("mathutils").Matrix.Translation(origin)


def planar_uv(obj, scale=0.36, name="UVMap"):
    """Top-down planar UVs in world space (good for a radially brushed top plate)."""
    me = obj.data
    if me.uv_layers:
        uv = me.uv_layers[0]
    else:
        uv = me.uv_layers.new(name=name)
    mw = obj.matrix_world
    for loop in me.loops:
        co = mw @ me.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = (co.x / scale + 0.5, co.y / scale + 0.5)


def tri_count(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    n = 0
    for o in objs:
        if o.type != "MESH":
            continue
        me = o.evaluated_get(dg).to_mesh()
        n += sum(len(p.vertices) - 2 for p in me.polygons)
    return n


# --------------------------------------------------------------------------- materials
def pbr(name, color, rough=0.5, metal=0.0, rough_tex=None, aniso=0.0, coat=0.0,
        coat_rough=0.1, emission=None, emission_strength=0.0, alpha=1.0,
        base_tex=None, normal_tex=None, normal_strength=1.0,
        sss=0.0, sss_radius=(1.0, 0.4, 0.2), sss_scale=0.002, spec=0.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Specular IOR Level"].default_value = spec
    if base_tex is not None:
        bt = nt.nodes.new("ShaderNodeTexImage")
        bt.image = base_tex
        bt.location = (-500, 300)
        nt.links.new(bt.outputs["Color"], bsdf.inputs["Base Color"])
    if normal_tex is not None:
        nt_img = nt.nodes.new("ShaderNodeTexImage")
        nt_img.image = normal_tex
        nt_img.location = (-800, -500)
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.inputs["Strength"].default_value = normal_strength
        nmap.location = (-400, -500)
        nt.links.new(nt_img.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    if sss > 0:
        bsdf.inputs["Subsurface Weight"].default_value = sss
        bsdf.inputs["Subsurface Radius"].default_value = sss_radius
        bsdf.inputs["Subsurface Scale"].default_value = sss_scale
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Coat Weight"].default_value = coat
    bsdf.inputs["Coat Roughness"].default_value = coat_rough
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.blend_method = "BLEND"
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if rough_tex is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = rough_tex
        tex.location = (-500, 0)
        tex.interpolation = "Linear"
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Roughness"])
    if aniso > 0:
        bsdf.inputs["Anisotropic"].default_value = aniso
        tan = nt.nodes.new("ShaderNodeTangent")
        tan.direction_type = "RADIAL"
        tan.axis = "Z"
        tan.location = (-500, -300)
        nt.links.new(tan.outputs["Tangent"], bsdf.inputs["Tangent"])
    return mat


def brushed_roughness_image(name="RoughBrushed", size=512, base=0.36, streak=0.12,
                            noise=0.07, seed=7):
    """Greyscale roughness map: fine radial 'brushed' streaks plus low-frequency blotches.
    Meant for a top-down planar UV centred on the robot."""
    rng = np.random.default_rng(seed)
    ys, xs = np.mgrid[0:size, 0:size]
    x = (xs + 0.5) / size * 2 - 1
    y = (ys + 0.5) / size * 2 - 1
    theta = np.arctan2(y, x)
    nb = 8192
    f = rng.standard_normal(nb)
    k = np.exp(-0.5 * (np.arange(-6, 7) / 2.0) ** 2)
    k /= k.sum()
    f = np.convolve(np.concatenate([f[-6:], f, f[:6]]), k, mode="valid")
    f = (f - f.mean()) / f.std()
    idx = ((theta / (2 * np.pi) + 0.5) * nb).astype(int) % nb
    streaks = f[idx]

    def value_noise(cells):
        g = rng.random((cells + 1, cells + 1))
        gx = np.linspace(0, cells, size, endpoint=False)
        i0 = np.floor(gx).astype(int)
        t = gx - i0
        t = t * t * (3 - 2 * t)
        a = g[np.ix_(i0, i0)]
        b = g[np.ix_(i0, i0 + 1)]
        c = g[np.ix_(i0 + 1, i0)]
        d = g[np.ix_(i0 + 1, i0 + 1)]
        ty, tx = t[:, None], t[None, :]
        return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty

    n = value_noise(6) * 0.6 + value_noise(24) * 0.3 + value_noise(96) * 0.1
    n = (n - n.mean()) / (n.std() + 1e-9)
    fine = rng.standard_normal((size, size)) * 0.015
    v = base + streak * 0.5 * streaks + noise * 0.5 * n + fine
    v = np.clip(v, 0.08, 0.95).astype(np.float32)
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    px = np.ones((size, size, 4), dtype=np.float32)
    px[..., 0] = px[..., 1] = px[..., 2] = v
    img.pixels.foreach_set(px.ravel())
    img.pack()
    return img


def fbm(size, rng, octaves=((4, 0.5), (12, 0.3), (40, 0.15), (128, 0.05)), tile=True):
    """Tileable fractal value noise in [0,1]-ish, shape (size, size)."""
    acc = np.zeros((size, size), dtype=np.float64)
    for cells, w in octaves:
        g = rng.random((cells, cells))
        gx = np.linspace(0, cells, size, endpoint=False)
        i0 = np.floor(gx).astype(int)
        t = gx - i0
        t = t * t * (3 - 2 * t)
        i1 = (i0 + 1) % cells if tile else np.minimum(i0 + 1, cells - 1)
        a = g[np.ix_(i0, i0)]
        b = g[np.ix_(i0, i1)]
        c = g[np.ix_(i1, i0)]
        d = g[np.ix_(i1, i1)]
        ty, tx = t[:, None], t[None, :]
        acc += w * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty)
    acc -= acc.min()
    acc /= acc.max() + 1e-9
    return acc


def image_from_array(name, arr, noncolor=True):
    """arr: (H, W) greyscale or (H, W, 3) RGB floats in 0..1 (row 0 = bottom, Blender order)."""
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    if noncolor:
        img.colorspace_settings.name = "Non-Color"
    px = np.ones((h, w, 4), dtype=np.float32)
    if arr.ndim == 2:
        px[..., 0] = px[..., 1] = px[..., 2] = arr
    else:
        px[..., :3] = arr
    img.pixels.foreach_set(np.clip(px, 0, 1).ravel())
    img.pack()
    return img


def normal_from_height(h, strength=4.0):
    """Tangent-space normal map (RGB 0..1, OpenGL +Y) from a tileable height field."""
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5 * strength
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5 * strength
    n = np.stack([-dx, -dy, np.ones_like(h)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def box_uv(obj, scale=0.1):
    """Per-face box projection UVs in world space (1 UV unit = `scale` metres)."""
    me = obj.data
    uv = me.uv_layers[0] if me.uv_layers else me.uv_layers.new(name="UVMap")
    mw = obj.matrix_world
    nm = mw.to_3x3()
    for p in me.polygons:
        n = nm @ p.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in p.loop_indices:
            co = mw @ me.vertices[me.loops[li].vertex_index].co
            if ax == 2:
                u, v = co.x, co.y
            elif ax == 1:
                u, v = co.x, co.z
            else:
                u, v = co.y, co.z
            uv.data[li].uv = (u / scale, v / scale)


# --------------------------------------------------------------------------- export / render
def export_glb(path, objects, draco=True, extras=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=extras,
    )
    if draco:
        kwargs.update(
            export_draco_mesh_compression_enable=True,
            export_draco_mesh_compression_level=6,
            export_draco_position_quantization=14,
            export_draco_normal_quantization=10,
            export_draco_texcoord_quantization=12,
        )
    bpy.ops.export_scene.gltf(**kwargs)
    return os.path.getsize(path)


def _enable_gpu():
    prefs = bpy.context.preferences.addons["cycles"].preferences
    try:
        prefs.compute_device_type = "METAL"
        prefs.refresh_devices()
        for d in prefs.devices:
            d.use = d.type != "CPU" or True
        return True
    except Exception:
        return False


def render_preview(path, target, cam_dir, distance, res=(1200, 900), samples=128,
                   focal=60.0, key_power=120.0, floor_z=0.0):
    """Cycles 3/4 preview with transparent background and a shadow catcher floor."""
    clear_preview_rig()
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.device = "GPU" if _enable_gpu() else "CPU"
    scene.render.film_transparent = True
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"

    # world: soft neutral ambient (invisible thanks to film_transparent)
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.30, 0.32, 0.35, 1.0)
    bg.inputs["Strength"].default_value = 0.35
    scene.world = world

    target = Vector(target)
    d = Vector(cam_dir).normalized()
    cam_data = bpy.data.cameras.new("PreviewCam")
    cam_data.lens = focal
    cam_data.sensor_width = 36
    cam = link(bpy.data.objects.new("PreviewCam", cam_data))
    cam.location = target + d * distance
    cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam

    def area(name, loc, power, size, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy = power
        ld.size = size
        ld.color = color
        lo = link(bpy.data.objects.new(name, ld))
        lo.location = Vector(loc)
        lo.rotation_euler = (target - lo.location).to_track_quat("-Z", "Y").to_euler()
        return lo

    right = d.cross(Vector((0, 0, 1))).normalized()
    area("Key", target + (d * 0.6 + right * 1.0 + Vector((0, 0, 1.3))) * 1.0, key_power, 1.2,
         (1.0, 0.97, 0.93))
    area("Fill", target + (d * 0.4 - right * 1.4 + Vector((0, 0, 0.6))) * 1.0, key_power * 0.3, 1.6,
         (0.9, 0.95, 1.0))
    area("Rim", target + (-d * 1.2 + right * 0.3 + Vector((0, 0, 1.0))) * 1.0, key_power * 0.5, 0.6,
         (1.0, 1.0, 1.0))

    bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, floor_z))
    floor = bpy.context.active_object
    floor.name = "ShadowCatcher"
    floor.is_shadow_catcher = True

    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


def clear_preview_rig():
    for n in ("PreviewCam", "Key", "Fill", "Rim", "ShadowCatcher", "TopSun", "TopSoftbox", "TopFloor"):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)


def render_top(path, center, extent, res=(1200, 1200), samples=128, up=(0, -1, 0),
               floor_color=(0.045, 0.022, 0.07), sun_strength=2.2, env_strength=0.5,
               softbox=True):
    """Straight-down orthographic preview that mimics the app: key light from the image's upper
    left at ~65 deg elevation, soft neutral environment, ACES 1.3 tone mapping, and an opaque
    floor tinted like the dark purple wallpaper (floor_color=None -> transparent shadow catcher).
    `up` is the world direction that points to the top of the image."""
    clear_preview_rig()
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.device = "GPU" if _enable_gpu() else "CPU"
    scene.render.film_transparent = floor_color is None
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "ACES 1.3"
    scene.view_settings.look = "None"

    world = bpy.data.worlds.new("TopWorld")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.85, 0.87, 0.9, 1.0)
    bg.inputs["Strength"].default_value = env_strength
    scene.world = world

    center = Vector(center)
    up = Vector(up).normalized()
    right = up.cross(Vector((0, 0, 1))).normalized()   # image right
    cam_data = bpy.data.cameras.new("PreviewCam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = extent
    cam = link(bpy.data.objects.new("PreviewCam", cam_data))
    cam.location = center + Vector((0, 0, 3.0))
    cam.rotation_euler = Vector((0, 0, -1)).to_track_quat("-Z", "Y").to_euler()
    cam.rotation_euler.z = math.atan2(-up.x, up.y)
    scene.camera = cam
    cam_data.clip_end = 10

    # key: from image upper-left, elevation ~65 deg (scene.js: offset (-2.2, 6, -1.6))
    horiz = (up * 1.6 - right * 2.2)
    sd = bpy.data.lights.new("TopSun", "SUN")
    sd.energy = sun_strength
    sd.angle = math.radians(4.0)
    sd.color = (1.0, 0.945, 0.88)
    sun = link(bpy.data.objects.new("TopSun", sd))
    to_light = (horiz + Vector((0, 0, 6.0))).normalized()
    sun.rotation_euler = (-to_light).to_track_quat("-Z", "Y").to_euler()

    if softbox:   # stands in for the ceiling panels of three's RoomEnvironment (seen in reflections)
        ad = bpy.data.lights.new("TopSoftbox", "AREA")
        ad.energy = 60
        ad.shape = "RECTANGLE"
        ad.size, ad.size_y = 1.6, 0.6
        sb = link(bpy.data.objects.new("TopSoftbox", ad))
        sb.location = center + up * 0.5 - right * 0.6 + Vector((0, 0, 2.2))
        sb.rotation_euler = (center - sb.location).to_track_quat("-Z", "Y").to_euler()

    bpy.ops.mesh.primitive_plane_add(size=8, location=(center.x, center.y, 0))
    floor = bpy.context.active_object
    floor.name = "TopFloor"
    if floor_color is None:
        floor.is_shadow_catcher = True
    else:
        fm = pbr("TopFloorMat", floor_color, rough=0.9, spec=0.2)
        floor.data.materials.append(fm)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path
