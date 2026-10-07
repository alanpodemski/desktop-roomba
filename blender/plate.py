"""White glazed ceramic dessert plate for the cake.

    blender -b -P blender/plate.py            # builds, exports public/models/plate.glb, renders previews
    blender -b -P blender/plate.py -- --no-render

Single mesh node "Plate", origin at the centre on the floor, metres (glTF +Y up).
  diameter 0.22 m, flat well to r = 0.075 m with its top surface at y = WELL_Z (0.006 m),
  rim rising smoothly to a rolled lip 0.016 m high at r ~ 0.108, foot ring r 0.053-0.060 underneath.
"""
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

RENDER = "--no-render" not in sys.argv

R = 0.110
WELL_R = 0.075
WELL_Z = 0.006
RIM_TOP = 0.016
T = 0.0034                 # body thickness
FOOT_IN, FOOT_OUT = 0.053, 0.060

C.reset_scene()
rng = np.random.default_rng(3)


def rim_z(r):
    """Top surface height of the rim between the well and the lip (flat start, ~33 deg at the lip)."""
    t = (r - WELL_R) / (0.1035 - WELL_R)
    return WELL_Z + (0.0153 - WELL_Z) * t * t


# profile (r, z) from the centre of the top surface outwards, round the lip, back along the underside
prof = [(0.0, WELL_Z)]
prof += [(WELL_R * k / 6, WELL_Z) for k in range(1, 7)]
prof += [(r, rim_z(r)) for r in np.linspace(WELL_R, 0.1035, 14)[1:]]
# rolled lip: top crest at 0.016, outer edge at r = 0.110
prof += C.arc(0.1068, 0.0137, 0.0024, 120, 90, 2)[1:]      # crest
prof += C.arc(0.1068, 0.0137, 0.0024, 90, 0, 5)[1:]        # over the edge
prof += C.arc(0.1068, 0.0137, 0.0024, 0, -110, 5)[1:]      # under the lip
# underside of the rim, parallel to the top
prof += [(r, rim_z(r) - T * 1.15) for r in np.linspace(0.1035, WELL_R, 12)[1:]]
prof += [(0.068, WELL_Z - T), (FOOT_OUT + 0.0015, WELL_Z - T)]
# foot ring: small rounded unglazed bead touching the floor
prof += C.arc(FOOT_OUT - 0.0012, 0.0012, 0.0012, 60, -90, 4)[1:]
prof += [(FOOT_IN + 0.0012, 0.0)]
prof += C.arc(FOOT_IN + 0.0012, 0.0012, 0.0012, -90, -180, 3)[1:]
prof += [(FOOT_IN, WELL_Z - T - 0.0002), (0.0, WELL_Z - T - 0.0002)]

# --------------------------------------------------------------------------- material
n = C.fbm(128, rng, octaves=((4, 0.5), (16, 0.3), (48, 0.2)))
rough_img = C.image_from_array("PlateGlazeRough", 0.07 + 0.08 * n)
glaze = C.pbr("PlateGlaze", (0.86, 0.885, 0.91), rough=0.1, rough_tex=rough_img, coat=1.0,
              coat_rough=0.03, spec=0.5)
foot = C.pbr("PlateFoot", (0.74, 0.73, 0.70), rough=0.75)   # unglazed biscuit ring

plate = C.revolve("Plate", prof, segments=112, materials=[glaze, foot],
                  mat_fn=lambda c: 1 if c.z < 0.0009 else 0, smooth_angle=50)
C.planar_uv(plate, scale=0.24)

lo = min(v.co.z for v in plate.data.vertices)
hi = max(v.co.z for v in plate.data.vertices)
rmax = max(math.hypot(v.co.x, v.co.y) for v in plate.data.vertices)
print("PLATE z %.4f..%.4f  r_max %.4f  well top %.4f" % (lo, hi, rmax, WELL_Z))
print("TRIS", C.tri_count([plate]))
out = os.path.join(C.MODELS, "plate.glb")
size = C.export_glb(out, [plate])
print("EXPORTED", out, size, "bytes")

if RENDER:
    top = os.path.join(C.HERE, "plate_top_preview.png")
    C.render_top(top, center=(0, 0, 0), extent=0.30, res=(1000, 1000), samples=128)
    print("RENDERED", top)
    # place the real cake.glb in the well to check scale
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.import_scene.gltf(filepath=os.path.join(C.MODELS, "cake.glb"))
    cake_root = bpy.data.objects.get("Cake")
    for name in ("CakeSquashed", "CakeCrumbs"):
        o = bpy.data.objects.get(name)
        if o:
            o.hide_render = True
    cake_root.location = (0.0, 0.0, WELL_Z)
    cake_root.rotation_euler.z += math.radians(-20)
    bpy.context.view_layer.update()
    tq = os.path.join(C.HERE, "plate_cake_top_preview.png")
    C.render_top(tq, center=(0, 0, 0), extent=0.30, res=(1000, 1000), samples=96)
    print("RENDERED", tq)
    png = os.path.join(C.HERE, "plate_preview.png")
    C.render_preview(png, target=(0.0, 0.0, 0.05), cam_dir=(1.0, 0.8, 0.55), distance=0.85,
                     res=(1200, 900), samples=128, focal=70, key_power=30)
    print("RENDERED", png)
