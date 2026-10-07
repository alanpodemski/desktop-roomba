"""Procedural auto-empty charging dock (premium charcoal station).

    blender -b -P blender/dock.py            # builds, exports public/models/dock.glb, renders previews
    blender -b -P blender/dock.py -- --no-render

Blender space: metres, floor z = 0, origin at the FRONT-CENTRE of the ramp, FRONT = +Y
(the side the robot approaches from).  The base wedge extends to y = -0.19 and the bin tower
occupies y = -0.19 .. -0.30.
glTF (after export, +Y up): the ramp opens towards -Z, the tower stands at z = +0.19 .. +0.30.
A docked robot drives in the +Z direction (towards the tower) and stops with its centre at
roughly (0, 0, +0.02) in dock-local coordinates, i.e. facing the tower.

The app sees this from straight above, so the design is built to read top-down:
glossy black hinged lid (crowned, so it catches the key light) with a seam line, finger grip,
vent slots and an LED strip at its front edge; matte charcoal body; dark knurled rubber ramp
with two bright charging contacts and an evacuation port.

Objects: DockBase, DockContacts, DockTower, DockLED (all parented to an empty "Dock").
The LED strip uses material "DockLED" (the renderer recolours its emissive by robot mode).
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

RENDER = "--no-render" not in sys.argv

BASE_W = 0.26
BASE_D = 0.19          # ramp front (y=0) to tower face (y=-0.19)
RAMP_Z0, RAMP_Z1 = 0.004, 0.019
RAMP_LEN = 0.085       # slope ends here, then flat
TOWER_W, TOWER_D = 0.20, 0.11
TOWER_Y = -(BASE_D + TOWER_D / 2)   # tower centre y (-0.245)
BODY_TOP = 0.282
LID_Z0, LID_Z1, LID_CROWN = 0.2836, 0.2965, 0.0035   # pillowed lid, peaks at 0.300
LID_INSET = 0.0028
LID_W, LID_D = TOWER_W - 2 * LID_INSET, TOWER_D - 2 * LID_INSET
LID_FRONT = TOWER_Y + LID_D / 2        # y of the lid's front edge (towards the ramp)

C.reset_scene()
rng = np.random.default_rng(11)


# ----------------------------------------------------------------------------- textures
def tex_roughness(name, lo, hi, smudge=False, size=256, brushed=False):
    n = C.fbm(size, rng)
    if smudge:   # long soft wipe marks + fingerprints-ish blotches on the glossy lid
        streak = C.fbm(size, rng, octaves=((3, 0.6), (9, 0.4)))
        streak = np.repeat(streak[:, :1], size, axis=1) * 0.35 + streak * 0.65
        n = 0.55 * n + 0.45 * streak
        n = n ** 2.2
    if brushed:   # fine streaks along V (the ramp direction)
        st = rng.standard_normal(size)
        st = np.convolve(np.concatenate([st[-3:], st, st[:3]]), np.ones(7) / 7, mode="valid")
        n = 0.35 * n + 0.65 * (st[None, :] - st.min()) / (np.ptp(st) + 1e-9)
    v = lo + (hi - lo) * n + rng.standard_normal((size, size)) * 0.006
    return C.image_from_array(name, v)


def tex_knurl(size=256, cells=8):
    """Diamond anti-slip knurl height field -> normal map + matching roughness."""
    ys, xs = np.mgrid[0:size, 0:size] / size * cells
    a = np.abs(((xs + ys) % 1.0) - 0.5)
    b = np.abs(((xs - ys) % 1.0) - 0.5)
    h = np.clip(1.0 - 2.2 * (a + b) / 1.0, 0, 1) ** 0.8          # little pyramids
    h += C.fbm(size, rng, octaves=((16, 0.5), (64, 0.5))) * 0.25
    nrm = C.normal_from_height(h, strength=3.0)
    rough = 0.74 + 0.14 * (1 - h / h.max()) + rng.standard_normal((size, size)) * 0.01
    return C.image_from_array("DockRubberNormal", nrm), C.image_from_array("DockRubberRough", rough)


rubber_n, rubber_r = tex_knurl()
M = dict(
    body=C.pbr("DockCharcoal", (0.040, 0.041, 0.045), rough=0.55,
               rough_tex=tex_roughness("DockCharcoalRough", 0.46, 0.66), coat=0.0),
    satin=C.pbr("DockSatin", (0.032, 0.033, 0.036), rough=0.38,
                rough_tex=tex_roughness("DockSatinRough", 0.30, 0.44)),
    lid=C.pbr("DockGlossBlack", (0.006, 0.006, 0.007), rough=0.12,
              rough_tex=tex_roughness("DockLidRough", 0.05, 0.20, smudge=True, size=512),
              coat=1.0, coat_rough=0.03),
    slot=C.pbr("DockSlot", (0.003, 0.003, 0.0035), rough=0.85),
    rubber=C.pbr("DockRubber", (0.016, 0.016, 0.017), rough=0.8, rough_tex=rubber_r,
                 normal_tex=rubber_n, normal_strength=0.8),
    metal=C.pbr("DockContact", (0.86, 0.84, 0.80), rough=0.18, metal=1.0,
                rough_tex=tex_roughness("DockContactRough", 0.14, 0.24, brushed=True)),
    trim=C.pbr("DockGunmetal", (0.33, 0.33, 0.35), rough=0.32, metal=1.0),
    led=C.pbr("DockLED", (0.05, 0.25, 0.23), rough=0.3, emission=(0.1, 0.85, 0.8),
              emission_strength=6.0),
)


# ----------------------------------------------------------------------------- helpers
def on_ramp(y):
    """z of the ramp's top surface at y (y <= 0)."""
    t = min(1.0, max(0.0, -y / RAMP_LEN))
    return RAMP_Z0 + (RAMP_Z1 - RAMP_Z0) * t


def rrect(x0, x1, y0, y1, r_front, r_back=None, seg=8):
    """Rounded rectangle, CCW, front = +Y side (y1).  Different radii front/back."""
    rb = r_front if r_back is None else r_back
    pts = []

    def corner(cx, cy, r, a0):
        n = seg if r > 0.005 else max(3, seg // 2)
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    corner(x1 - r_front, y1 - r_front, r_front, 0)      # front-right
    corner(x0 + r_front, y1 - r_front, r_front, 90)     # front-left
    corner(x0 + rb, y0 + rb, rb, 180)                   # back-left
    corner(x1 - rb, y0 + rb, rb, 270)                   # back-right
    out = []
    for p in pts:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > 1e-6:
            out.append(p)
    return out


def slab(name, pts, zbot, ztop, mat, cuts_x=(), cuts_y=(), bevel=0.0, bevel_seg=4,
         bevel_angle=30.0):
    """Extrude a 2D outline between two height functions zbot(x, y) / ztop(x, y).
    Planes x = c / y = c are cut first so the surface can follow ramps and crowns."""
    bm = bmesh.new()
    bot = [bm.verts.new((x, y, 0.0)) for x, y in pts]
    top = [bm.verts.new((x, y, 1.0)) for x, y in pts]
    bm.faces.new(bot[::-1])
    bm.faces.new(top)
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([bot[i], bot[j], top[j], top[i]])
    for c in cuts_y:
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                               plane_co=(0, c, 0), plane_no=(0, 1, 0))
    for c in cuts_x:
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                               plane_co=(c, 0, 0), plane_no=(1, 0, 0))
    for v in bm.verts:
        x, y = v.co.x, v.co.y
        v.co.z = ztop(x, y) if v.co.z > 0.5 else zbot(x, y)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = C.link(bpy.data.objects.new(name, me))
    obj.data.materials.append(mat)
    if bevel > 0:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = bevel_seg
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(bevel_angle)
        mod.use_clamp_overlap = True
        C.apply_modifiers(obj)
    C.smooth(obj, 35)
    return obj


def frange(a, b, step):
    n = int(round((b - a) / step))
    return [a + (b - a) * i / n for i in range(1, n)]


def boolean(target, cutter, op="DIFFERENCE"):
    mod = target.modifiers.new("Bool", "BOOLEAN")
    mod.operation = op
    mod.solver = "EXACT"
    mod.object = cutter
    mod.material_mode = "TRANSFER"
    C.apply_modifiers(target)
    bpy.data.objects.remove(cutter, do_unlink=True)


RAMP_CUTS = [-RAMP_LEN] + frange(0.0, -RAMP_LEN, 0.02) + frange(-RAMP_LEN, -0.20, 0.03)
parts = []

# ----------------------------------------------------------------------------- base
foot = rrect(-BASE_W / 2, BASE_W / 2, -0.200, 0.0, 0.045, 0.012)
base = slab("DockBase", foot, lambda x, y: 0.0, lambda x, y: on_ramp(y), M["body"],
            cuts_y=RAMP_CUTS, bevel=0.0019, bevel_seg=4, bevel_angle=25)

# knurled rubber ramp insert (slightly proud, follows the slope)
ins = rrect(-0.114, 0.114, -0.176, -0.008, 0.034, 0.010)
insert = slab("RampInsert", ins, lambda x, y: on_ramp(y) - 0.0006, lambda x, y: on_ramp(y) + 0.0011,
              M["rubber"], cuts_y=RAMP_CUTS, bevel=0.0006, bevel_seg=2)

# evacuation port near the tower: dark mouth with a few rubber grille bars
PORT_Y = -0.146
port = slab("Port", rrect(-0.052, 0.052, PORT_Y - 0.0145, PORT_Y + 0.0145, 0.0145),
            lambda x, y: on_ramp(y), lambda x, y: on_ramp(y) + 0.0013, M["slot"],
            bevel=0.0005, bevel_seg=2)
bars = []
for k in range(-3, 4):
    bx = k * 0.0135
    bars.append(slab("PortBar", rrect(bx - 0.0016, bx + 0.0016, PORT_Y - 0.0115, PORT_Y + 0.0115, 0.0015),
                     lambda x, y: on_ramp(y), lambda x, y: on_ramp(y) + 0.0017, M["rubber"],
                     bevel=0.0005, bevel_seg=2))

# low guide rails along the flat section
rails = []
for sx in (-1, 1):
    xc = sx * (BASE_W / 2 - 0.0085)
    rails.append(slab("Rail", rrect(xc - 0.0055, xc + 0.0055, -0.188, -0.098, 0.0055),
                      lambda x, y: RAMP_Z1 - 0.001, lambda x, y: RAMP_Z1 + 0.0075, M["body"],
                      bevel=0.0035, bevel_seg=5))
base = C.join("DockBase", [base, insert, port] + bars + rails, origin=(0, 0, 0))
C.box_uv(base, 0.04)
parts.append(base)

# ----------------------------------------------------------------------------- charging contacts
CON_Y, CON_X = -0.052, 0.048
cons = []
for sx in (-1, 1):
    xc = sx * CON_X
    cons.append(slab("Contact", rrect(xc - 0.0095, xc + 0.0095, CON_Y - 0.026, CON_Y + 0.026, 0.004),
                     lambda x, y: on_ramp(y) + 0.0004, lambda x, y: on_ramp(y) + 0.0026, M["metal"],
                     cuts_y=[c for c in RAMP_CUTS if CON_Y - 0.026 < c < CON_Y + 0.026],
                     bevel=0.0008, bevel_seg=3))
contacts = C.join("DockContacts", cons, origin=(0, 0, 0))
C.box_uv(contacts, 0.05)
parts.append(contacts)

# ----------------------------------------------------------------------------- tower body
tfoot = rrect(-TOWER_W / 2, TOWER_W / 2, TOWER_Y - TOWER_D / 2, TOWER_Y + TOWER_D / 2, 0.018, seg=10)
body = slab("TowerBody", tfoot, lambda x, y: 0.0, lambda x, y: BODY_TOP, M["body"],
            bevel=0.0026, bevel_seg=4)
# seam: thin black band visible between body rim and lid
seam = slab("Seam", rrect(-TOWER_W / 2 + 0.0024, TOWER_W / 2 - 0.0024, TOWER_Y - TOWER_D / 2 + 0.0024,
                          TOWER_Y + TOWER_D / 2 - 0.0024, 0.0158, seg=10),
            lambda x, y: BODY_TOP - 0.001, lambda x, y: LID_Z0 + 0.0004, M["slot"])

# front bin door (satin panel in a dark reveal) and evacuation mouth at its foot
FRONT_Y = TOWER_Y + TOWER_D / 2
door_reveal = C.box("DoorReveal", (0.152, 0.002, 0.196), (0, FRONT_Y + 0.0003, 0.150), bevel=0.006,
                    segments=4, material=M["slot"])
door = C.box("Door", (0.148, 0.0026, 0.192), (0, FRONT_Y + 0.0009, 0.150), bevel=0.0058, segments=5,
             material=M["satin"])
mouth = C.box("Mouth", (0.11, 0.004, 0.018), (0, FRONT_Y + 0.0006, 0.0315), bevel=0.006, segments=4,
              material=M["slot"])
# rear vent louvres (seen in the 3/4 view)
louvres = []
for k in range(7):
    louvres.append(C.box("Louvre", (0.12, 0.003, 0.0035), (0, TOWER_Y - TOWER_D / 2 + 0.0011, 0.17 + k * 0.011),
                         bevel=0.0012, segments=2, material=M["slot"]))
# hinge barrel along the back edge of the lid
hinge = C.cylinder("Hinge", 0.0036, 0.150, 20, (0, LID_FRONT - LID_D + 0.0005, LID_Z0 + 0.0030),
                   rot=(0, math.pi / 2, 0), material=M["trim"])
hm = hinge.modifiers.new("Bevel", "BEVEL")
hm.width, hm.segments, hm.limit_method = 0.0012, 3, "ANGLE"
C.apply_modifiers(hinge)
C.smooth(hinge, 40)


# ----------------------------------------------------------------------------- lid
def crown(x, y):
    u = min(1.0, abs(x) / (LID_W / 2))
    v = min(1.0, abs(y - TOWER_Y) / (LID_D / 2))
    return LID_Z1 + LID_CROWN * (1.0 - u ** 4) * (1.0 - v ** 4)


lfoot = rrect(-LID_W / 2, LID_W / 2, TOWER_Y - LID_D / 2, TOWER_Y + LID_D / 2, 0.0156, seg=10)
lid = slab("Lid", lfoot, lambda x, y: LID_Z0, crown, M["lid"],
           cuts_x=frange(-LID_W / 2, LID_W / 2, 0.0065),
           cuts_y=frange(TOWER_Y - LID_D / 2, TOWER_Y + LID_D / 2, 0.0055),
           bevel=0.0048, bevel_seg=7, bevel_angle=30)

# finger grip: recessed stadium-shaped pocket with a filleted floor behind the front edge
GRIP_Y = LID_FRONT - 0.024
grip = slab("GripCut", rrect(-0.026, 0.026, GRIP_Y - 0.0065, GRIP_Y + 0.0065, 0.0064, seg=12),
            lambda x, y: crown(0, GRIP_Y) - 0.0042, lambda x, y: crown(0, GRIP_Y) + 0.01, M["slot"],
            bevel=0.0024, bevel_seg=4, bevel_angle=60)
boolean(lid, grip)

# vent slots: a row of short rounded slots on the rear of the lid
VENT_Y = TOWER_Y - 0.024
vcut = []
for k in range(-7, 8):
    vx = k * 0.0074
    s = C.box("VentCut", (0.0026, 0.019, 0.010), (vx, VENT_Y, crown(vx, VENT_Y) + 0.005 - 0.0022),
              bevel=0.00125, segments=3, material=M["slot"])
    C.apply_modifiers(s)
    vcut.append(s)
boolean(lid, C.join("VentCutter", vcut))

# LED strip slot right at the front edge
LED_Y = LID_FRONT - 0.0068
lcut = C.box("LedCut", (0.058, 0.0042, 0.010), (0, LED_Y, crown(0, LED_Y) + 0.005 - 0.0012),
             bevel=0.0019, segments=3, material=M["slot"])
C.apply_modifiers(lcut)
boolean(lid, lcut)
C.smooth(lid, 35)

tower = C.join("DockTower", [body, seam, lid, door_reveal, door, mouth, hinge] + louvres,
               origin=(0, TOWER_Y, 0))
C.box_uv(tower, 0.12)
parts.append(tower)

# ----------------------------------------------------------------------------- status LED strip
led = C.box("DockLED", (0.055, 0.0034, 0.004), (0, LED_Y, crown(0, LED_Y) - 0.0021),
            bevel=0.0015, segments=3, material=M["led"])
C.apply_modifiers(led)
C.smooth(led, 40)
C.box_uv(led, 0.05)
parts.append(led)

# ----------------------------------------------------------------------------- root + export
root = C.link(bpy.data.objects.new("Dock", None))
for p in parts:
    p.parent = root
    p.matrix_parent_inverse = root.matrix_world.inverted()

print("PARTS", sorted(p.name for p in parts))
print("TRIS", C.tri_count(parts))
out = os.path.join(C.MODELS, "dock.glb")
size = C.export_glb(out, [root] + parts)
print("EXPORTED", out, size, "bytes")

if RENDER:
    png = os.path.join(C.HERE, "dock_preview.png")
    C.render_preview(png, target=(0.0, -0.14, 0.12), cam_dir=(1.0, 1.05, 0.62), distance=1.1,
                     res=(1200, 900), samples=128, focal=60, key_power=45)
    print("RENDERED", png)
    top = os.path.join(C.HERE, "dock_top_preview.png")
    C.render_top(top, center=(0.0, -0.15, 0.0), extent=0.42, res=(1200, 1200), samples=128)
    print("RENDERED", top)
