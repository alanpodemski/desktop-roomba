"""Procedural Roomba-like robot vacuum.

    blender -b -P blender/roomba.py            # builds, exports public/models/roomba.glb, renders preview
    blender -b -P blender/roomba.py -- --no-render

Blender space: metres, floor z = 0, robot centre at origin, FRONT = +Y.
glTF (after export, +Y up): front = -Z, right = +X, up = +Y.

Object names / origins (glTF coords, metres):
  Body      origin (0,0,0) on the floor under the robot centre
  Bumper    origin (0,0,0); push it +Z (backwards) a few mm to show compression
  Buttons   origin on the top plate
  Turret    origin at its base on the top plate
  WheelL    origin at the axle (-0.115, 0.0325, 0); spins about local X
  WheelR    origin at the axle (+0.115, 0.0325, 0); spins about local X
  Caster    origin at its pivot under the body (0, 0.012, -0.118); wheel spins about X
  SideBrush origin on its spin axis (+0.105, 0.012, -0.095); spins about local Y, bristle tips at y=0
  Roller    origin at its axle (0, 0.018, -0.045); spins about local X
  EyeL/EyeR shallow discs on top, centres (-/+0.05, 0.0895, -0.06), dia 0.06
"""
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

RENDER = "--no-render" not in sys.argv

# ----------------------------------------------------------------------------- dimensions
R_BODY = 0.160          # main shell radius
R_BUMPER_IN = 0.163
R_BUMPER_OUT = 0.170    # overall diameter 0.34 m
Z_BOTTOM = 0.012        # ground clearance of the shell
Z_TOP = 0.0875          # outer rim height; inner plate is 0.089 -> robot ~0.09 m tall
WHEEL_R = 0.0325
WHEEL_W = 0.022
WHEEL_X = 0.115
EYE_POS = [(-0.05, 0.06), (0.05, 0.06)]
TURRET_POS = (0.0, -0.108)
BUTTONS_POS = (0.0, -0.024)
SIDEBRUSH_POS = (0.105, 0.095, 0.012)
CASTER_POS = (0.0, 0.118, Z_BOTTOM)
ROLLER_POS = (0.0, 0.045, 0.018)

C.reset_scene()

# ----------------------------------------------------------------------------- materials
rough_img = C.brushed_roughness_image(base=0.34, streak=0.06, noise=0.05)
M = dict(
    graphite=C.pbr("Graphite", (0.024, 0.025, 0.028), rough=0.34, metal=0.0, rough_tex=rough_img,
                   aniso=0.22, coat=0.12, coat_rough=0.2),
    bumper=C.pbr("BumperGrey", (0.070, 0.073, 0.080), rough=0.48, rough_tex=rough_img),
    gloss=C.pbr("GlossBlack", (0.006, 0.006, 0.007), rough=0.26, coat=0.12, coat_rough=0.1),
    matte=C.pbr("MatteBlack", (0.010, 0.010, 0.011), rough=0.55),
    glass=C.pbr("TurretGlass", (0.004, 0.004, 0.006), rough=0.04, coat=1.0, coat_rough=0.02),
    rubber=C.pbr("Rubber", (0.016, 0.016, 0.016), rough=0.78),
    hub=C.pbr("HubGrey", (0.055, 0.057, 0.062), rough=0.5),
    bristle=C.pbr("Bristle", (0.55, 0.55, 0.52), rough=0.65),
    eye=C.pbr("EyeWhite", (0.86, 0.86, 0.85), rough=0.22, coat=0.4),
    ring=C.pbr("ButtonLight", (0.25, 0.55, 0.42), rough=0.3, emission=(0.45, 0.95, 0.70),
               emission_strength=3.0),
    roller=C.pbr("RollerRubber", (0.045, 0.085, 0.060), rough=0.7),
    dark=C.pbr("UndersideDark", (0.012, 0.012, 0.013), rough=0.9),
)

parts = []

# ----------------------------------------------------------------------------- Body
f = 0.015  # top edge fillet
prof = [(0.0, 0.089), (0.1315, 0.089)]
prof += C.arc(0.1315, 0.0875, 0.0015, 90, 0, 3)                 # tiny step down to the rim
prof += [(0.1335, 0.0875), (R_BODY - f, 0.0875)]
prof += C.arc(R_BODY - f, 0.0875 - f, f, 90, 0, 8)[1:]          # big top fillet
prof += [(R_BODY, 0.064), (R_BODY - 0.0015, 0.0625), (R_BODY - 0.0015, 0.0605), (R_BODY, 0.059)]  # bumper shadow line
prof += [(R_BODY, Z_BOTTOM + 0.004)]
prof += C.arc(R_BODY - 0.004, Z_BOTTOM + 0.004, 0.004, 0, -90, 3)[1:]
prof += [(0.0, Z_BOTTOM)]
body = C.revolve("Body", prof, segments=128, materials=[M["graphite"], M["dark"]],
                 mat_fn=lambda c: 1 if c.z < Z_BOTTOM + 0.0005 else 0)

# cut-outs in the underside: intake slot, wheel wells, caster well (boolean, material transfer)
cutters = []
cutters.append(C.box("CutSlot", (0.19, 0.052, 0.045), (0, ROLLER_POS[1], 0.0125), material=M["dark"]))
for sx in (-1, 1):
    cutters.append(C.box("CutWheel", (0.032, 0.080, 0.06), (sx * WHEEL_X, 0, 0.02), material=M["dark"]))
cutters.append(C.cylinder("CutCaster", 0.021, 0.04, 32, (CASTER_POS[0], CASTER_POS[1], 0.01),
                          material=M["dark"]))
cutter = C.join("Cutter", cutters)
bm = body.modifiers.new("Cut", "BOOLEAN")
bm.operation = "DIFFERENCE"
bm.solver = "EXACT"
bm.object = cutter
bm.material_mode = "TRANSFER"
C.apply_modifiers(body)
bpy.data.objects.remove(cutter, do_unlink=True)
C.smooth(body, 30)
C.planar_uv(body)
parts.append(body)

# ----------------------------------------------------------------------------- Bumper (front 235 deg)
bprof = C.rounded_rect_profile(R_BUMPER_IN, R_BUMPER_OUT, 0.017, 0.058, 0.0028, 4)
# groove line around the bumper
bumper = C.revolve("Bumper", bprof, segments=96, angle=235.0, start=90.0 - 117.5,
                   closed_profile=True, materials=[M["bumper"]])
C.planar_uv(bumper)
parts.append(bumper)

# ----------------------------------------------------------------------------- Buttons cluster
bx, by = BUTTONS_POS
base = C.revolve("BtnBase", [(0, 0.002), (0.039, 0.002)] + C.arc(0.039, 0.0, 0.002, 90, 0, 3) + [(0.0, 0.0)],
                 segments=64, materials=[M["hub"]])
base.location = (bx, by, 0.089)
ring = C.revolve("BtnRing", C.rounded_rect_profile(0.0245, 0.0285, 0.0, 0.0032, 0.0008, 2),
                 segments=64, closed_profile=True, materials=[M["ring"]])
ring.location = (bx, by, 0.0905)
cprof = [(0, 0.0075), (0.019, 0.0075)] + C.arc(0.019, 0.0045, 0.003, 90, 0, 5) + [(0.022, 0.0), (0.0, 0.0)]
centre = C.revolve("BtnCentre", cprof, segments=64, materials=[M["gloss"]])
centre.location = (bx, by, 0.0905)
smalls = []
for sx in (-1, 1):
    sp = [(0, 0.004), (0.0065, 0.004)] + C.arc(0.0065, 0.0025, 0.0015, 90, 0, 3) + [(0.008, 0.0), (0.0, 0.0)]
    s = C.revolve("BtnSmall", sp, segments=32, materials=[M["gloss"]])
    s.location = (bx + sx * 0.0315, by, 0.0905)
    smalls.append(s)
buttons = C.join("Buttons", [base, ring, centre] + smalls, origin=(bx, by, 0.089))
C.planar_uv(buttons)
parts.append(buttons)

# ----------------------------------------------------------------------------- Turret (lidar)
tx, ty = TURRET_POS
tprof = [(0.0, 0.0235), (0.026, 0.0235)] + C.arc(0.026, 0.019, 0.0045, 90, 0, 5)
tprof += [(0.0305, 0.0175), (0.0295, 0.017), (0.0295, 0.0105), (0.0305, 0.010)]   # window band (recessed)
tprof += [(0.0305, 0.0045)] + C.arc(0.0315, 0.0045, 0.001, 180, 90, 2) + [(0.0325, 0.0055), (0.0345, 0.0045)]
tprof += C.arc(0.0325, 0.0025, 0.002, 0, -90, 2)[1:] + [(0.0, 0.0005), (0.0, 0.0)]
turret = C.revolve("Turret", tprof, segments=72, materials=[M["gloss"], M["glass"], M["hub"], M["matte"]],
                   mat_fn=lambda c: 1 if 0.0105 < c.z < 0.017 else (2 if c.z < 0.007 else (3 if c.z > 0.0232 else 0)))
turret.location = (tx, ty, 0.089)
C.planar_uv(turret)
parts.append(turret)

# ----------------------------------------------------------------------------- Eyes
eyes = []
for name, (ex, ey) in zip(("EyeL", "EyeR"), EYE_POS):
    ep = [(0, 0.004), (0.026, 0.004)] + C.arc(0.026, 0.0, 0.004, 90, 0, 5) + [(0.0, 0.0)]
    e = C.revolve(name, ep, segments=64, materials=[M["eye"]])
    e.location = (ex, ey, 0.0895)
    parts.append(e)

# ----------------------------------------------------------------------------- Wheels (axis X)
def tread(i, j, r, h):
    # sawtooth tread on the outer tyre surface
    if r > WHEEL_R - 0.0004 and (i % 4) in (0, 1):
        return r - 0.0012
    return r

for name, sx in (("WheelL", -1), ("WheelR", 1)):
    tyre_prof = C.rounded_rect_profile(0.0215, WHEEL_R, -WHEEL_W / 2, WHEEL_W / 2, 0.004, 4)
    tyre = C.revolve(name + "_tyre", tyre_prof, segments=96, axis="X", closed_profile=True,
                     radius_fn=tread, materials=[M["rubber"]], smooth_angle=40)
    hub_prof = [(0, 0.006), (0.0115, 0.006)] + C.arc(0.0115, 0.0045, 0.0015, 90, 0, 2)
    hub_prof += [(0.013, 0.004), (0.016, 0.004), (0.016, 0.0055), (0.0222, 0.0055), (0.0222, -0.0055),
                 (0, -0.0055)]
    hub = C.revolve(name + "_hub", hub_prof, segments=48, axis="X", materials=[M["hub"]])
    # hub cap faces outwards (+X for right wheel, -X for left)
    hub.scale.x = sx
    bpy.ops.object.select_all(action="DESELECT")
    hub.select_set(True)
    bpy.context.view_layer.objects.active = hub
    bpy.ops.object.transform_apply(scale=True)
    w = C.join(name, [tyre, hub])
    w.location = (sx * WHEEL_X, 0.0, WHEEL_R)
    parts.append(w)

# ----------------------------------------------------------------------------- Caster (front)
cx, cy, cz = CASTER_POS
house = C.revolve("CasterHouse", [(0, 0.0), (0.016, 0.0)] + C.arc(0.016, -0.003, 0.003, 0, -90, 3) + [(0, -0.006)],
                  segments=40, materials=[M["hub"]])
house.location = (cx, cy, cz + 0.0005)
fork = C.box("CasterFork", (0.006, 0.028, 0.008), (cx, cy, cz - 0.0075), bevel=0.001, segments=2,
             material=M["hub"])
cw = C.revolve("CasterWheel", C.rounded_rect_profile(0.004, 0.0115, -0.0055, 0.0055, 0.0025, 3),
               segments=40, axis="X", closed_profile=True, materials=[M["rubber"]])
cw.location = (cx, cy, 0.0125)
caster = C.join("Caster", [house, fork, cw], origin=(cx, cy, cz))
parts.append(caster)

# ----------------------------------------------------------------------------- Side brush (right-front)
sx_, sy_, sz_ = SIDEBRUSH_POS
hub = C.revolve("SBHub", [(0, 0.0), (0.012, 0.0)] + C.arc(0.012, -0.003, 0.003, 0, -90, 3) + [(0, -0.006)],
                segments=40, materials=[M["hub"]])
hub.location = (sx_, sy_, sz_ + 0.003)
sb_parts = [hub]
for k in range(3):
    yaw = math.radians(90 + k * 120)
    dirv = Vector((math.cos(yaw), math.sin(yaw), 0))
    droop = math.radians(7)
    core = C.box("SBArm", (0.030, 0.0075, 0.0022), (0, 0, 0), bevel=0.0008, segments=2, material=M["hub"])
    core.rotation_euler = (0, droop, yaw)
    core.location = Vector((sx_, sy_, sz_ - 0.0045)) + dirv * 0.025
    sb_parts.append(core)
    for b in range(7):
        spread = math.radians((b - 3) * 4.2)
        bdroop = math.radians(8.5)
        L = 0.036
        br = C.cylinder("SBBristle", 0.0009, L, 6, material=M["bristle"])
        br.rotation_euler = (0, math.pi / 2 + bdroop, yaw + spread)
        dv = Vector((math.cos(yaw + spread), math.sin(yaw + spread), 0))
        mid = 0.037 + L / 2 * math.cos(bdroop)
        br.location = Vector((sx_, sy_, sz_ - 0.0045 - (L / 2) * math.sin(bdroop) - 0.0012)) + dv * mid
        sb_parts.append(br)
sidebrush = C.join("SideBrush", sb_parts, origin=(sx_, sy_, sz_))
parts.append(sidebrush)

# ----------------------------------------------------------------------------- Roller (main brush)
rx, ry, rz = ROLLER_POS
core = C.revolve("RollerCore", [(0, -0.084), (0.0095, -0.084)] + [(0.0095, 0.084), (0, 0.084)],
                 segments=32, axis="X", materials=[M["roller"]])
core.location = (rx, ry, rz)
# helical fins built directly with bmesh
import bmesh  # noqa: E402
fin_me = bpy.data.meshes.new("RollerFins")
fbm = bmesh.new()
nst = 36
L = 0.164
for fin in range(4):
    a0 = fin * math.pi / 2
    rows = []
    for s in range(nst + 1):
        t = s / nst
        x = -L / 2 + L * t
        a = a0 + math.pi * 0.9 * t
        ca, sa = math.cos(a), math.sin(a)
        n_in, n_out = 0.0085, 0.0165
        hw = 0.0009
        # tangent direction for thickness
        tx_, ty_ = -sa, ca
        row = [fbm.verts.new((x, n_in * ca - hw * tx_, n_in * sa - hw * ty_)),
               fbm.verts.new((x, n_out * ca - hw * tx_, n_out * sa - hw * ty_)),
               fbm.verts.new((x, n_out * ca + hw * tx_, n_out * sa + hw * ty_)),
               fbm.verts.new((x, n_in * ca + hw * tx_, n_in * sa + hw * ty_))]
        rows.append(row)
    for s in range(nst):
        a, b = rows[s], rows[s + 1]
        for j in range(4):
            j2 = (j + 1) % 4
            fbm.faces.new([a[j], b[j], b[j2], a[j2]])
    fbm.faces.new(rows[0][::-1])
    fbm.faces.new(rows[-1])
bmesh.ops.recalc_face_normals(fbm, faces=fbm.faces)
fbm.to_mesh(fin_me)
fbm.free()
fins = C.link(bpy.data.objects.new("RollerFins", fin_me))
fins.data.materials.append(M["roller"])
fins.location = (rx, ry, rz)
C.smooth(fins, 35)
roller = C.join("Roller", [core, fins], origin=(rx, ry, rz))
parts.append(roller)

# ----------------------------------------------------------------------------- root + export
root = C.link(bpy.data.objects.new("Roomba", None))
for p in parts:
    p.parent = root
    p.matrix_parent_inverse = root.matrix_world.inverted()

names = sorted(p.name for p in parts)
print("PARTS", names)
print("TRIS", C.tri_count(parts))
out = os.path.join(C.MODELS, "roomba.glb")
size = C.export_glb(out, [root] + parts)
print("EXPORTED", out, size, "bytes")

if RENDER:
    png = os.path.join(C.HERE, "roomba_preview.png")
    C.render_preview(png, target=(0.0, 0.01, 0.045), cam_dir=(1.0, 0.9, 0.62), distance=0.95,
                     res=(1200, 900), samples=128, focal=70, key_power=45)
    print("RENDERED", png)
