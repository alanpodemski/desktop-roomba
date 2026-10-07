"""Procedural slice of chocolate layer cake (+ a squashed version) for the cake incident.

    blender -b -P blender/cake.py            # builds, exports public/models/cake.glb, renders previews
    blender -b -P blender/cake.py -- --no-render

Blender space: metres, floor z = 0, origin at the centre of the footprint, TIP towards +Y.
glTF (after export, +Y up): tip at -Z (0, 0, -0.065), curved frosted back at +Z (+0.065).

Standing slice: wedge 0.13 m tip-to-back, 30 deg tip angle (back chord 0.067 m), 0.11 m tall.
Layers bottom->top: sponge 0-0.028, ganache 0.028-0.0355, sponge -0.0635, ganache -0.071,
sponge -0.099, top frosting to ~0.110 (+ rosette, cherry, shavings on top).

Meshes (all origins at the footprint centre on the floor, so the renderer can pivot the root):
  CakeSponge, CakeFilling, CakeFrosting, CakeTopping   the standing slice
  CakeCrumbs      a few loose crumbs on the floor around the slice (keep on the floor when tipping)
  CakeSquashed    flattened blob ~0.18 m across, <= 0.02 m high (extras.hidden = true; hide it
                  on load and crossfade to it when the cake is crushed)
"""
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

RENDER = "--no-render" not in sys.argv

ALPHA = math.radians(15.0)       # half tip angle
LEN = 0.13                       # tip to back (outer frosting)
TIP_Y = LEN / 2                  # tip at +Y, back apex at -Y
R_SP = 0.1238                    # sponge/filling radius (under the back frosting)
R_FR_IN = 0.1232                 # frosting inner radius (slight overlap with sponge)
R_FR = LEN                       # frosting outer radius
Z_LAYERS = [0.0, 0.028, 0.0355, 0.0635, 0.071, 0.0995]   # interfaces (last = sponge top)
Z_FR_BOT = 0.099
Z_FR_TOP = 0.1088                # mean height of the frosted top
Z_EDGE = 0.1062                  # where the back wall starts to round over

C.reset_scene()
rng = np.random.default_rng(5)
random.seed(5)


# ----------------------------------------------------------------------------- noise
def _h(ix, iy, s):
    n = (ix * 374761393 + iy * 668265263 + s * 2246822519) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF) / 65535.0


def vnoise(x, y, s=0):
    """Smooth value noise in [-1, 1]."""
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = _h(ix, iy, s), _h(ix + 1, iy, s)
    c, d = _h(ix, iy + 1, s), _h(ix + 1, iy + 1, s)
    return 2.0 * ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy) - 1.0


def fbm2(x, y, s=0, oct=3):
    v, a, f = 0.0, 0.5, 1.0
    for o in range(oct):
        v += a * vnoise(x * f, y * f, s + o * 17)
        a *= 0.5
        f *= 2.03
    return v


def polar(x, y):
    """(r, theta) about the tip; theta = 0 along the wedge axis (towards the back)."""
    dx, dy = x, TIP_Y - y
    return math.hypot(dx, dy), math.atan2(dx, dy)


def world(r, th, z):
    return Vector((r * math.sin(th), TIP_Y - r * math.cos(th), z))


# ----------------------------------------------------------------------------- textures
def tex_sponge(size=512):
    """Crumb structure: open pores + crumb highlights. Returns (sRGB colour, normal, roughness)."""
    f1 = C.fbm(size, rng, octaves=((64, 0.4), (128, 0.4), (256, 0.2)))
    f2 = C.fbm(size, rng, octaves=((24, 0.5), (96, 0.5)))
    pores = np.clip((0.36 - f1) / 0.10, 0, 1) ** 1.5        # 1 inside a pore
    height = 1.0 - 0.8 * pores + 0.2 * (f2 - 0.5)
    base = np.array([0.36, 0.205, 0.13])                    # sRGB-ish chocolate sponge
    shade = (0.70 + 0.30 * height)[..., None] * (0.94 + 0.12 * f2[..., None])
    col = base[None, None, :] * shade
    col[..., 0] *= 1.0 + 0.06 * (f2 - 0.5)
    nrm = C.normal_from_height(height, strength=3.0)
    rough = 0.72 + 0.2 * pores
    col_img = C.image_from_array("SpongeColor", col, noncolor=False)
    return col_img, C.image_from_array("SpongeNormal", nrm), C.image_from_array("SpongeRough", rough)


def tex_frosting(size=256):
    f = C.fbm(size, rng, octaves=((8, 0.4), (32, 0.35), (96, 0.25)))
    bub = C.fbm(size, rng, octaves=((70, 0.6), (150, 0.4)))
    h = f * 0.6 - np.clip((0.3 - bub) / 0.08, 0, 1) * 0.5     # tiny air bubbles
    nrm = C.normal_from_height(h, strength=2.0)
    rough = 0.44 + 0.16 * f + 0.06 * np.clip((0.3 - bub) / 0.08, 0, 1)
    return C.image_from_array("FrostingNormal", nrm), C.image_from_array("FrostingRough", rough)


sp_col, sp_nrm, sp_rough = tex_sponge()
fr_nrm, fr_rough = tex_frosting()
M = dict(
    sponge=C.pbr("ChocSponge", (0.06, 0.025, 0.013), rough=0.8, base_tex=sp_col, normal_tex=sp_nrm,
                 normal_strength=1.0, rough_tex=sp_rough, sss=0.12, sss_radius=(1.0, 0.45, 0.25),
                 sss_scale=0.0008, spec=0.35),
    ganache=C.pbr("Ganache", (0.026, 0.009, 0.0042), rough=0.16, spec=0.4),
    frosting=C.pbr("ChocFrosting", (0.040, 0.0135, 0.0055), rough=0.42, normal_tex=fr_nrm,
                   normal_strength=0.15, rough_tex=fr_rough, sss=0.1, sss_radius=(1.0, 0.5, 0.3),
                   sss_scale=0.001, spec=0.25),
    shaving=C.pbr("ChocShaving", (0.022, 0.008, 0.004), rough=0.35, spec=0.4),
    shaving_milk=C.pbr("ChocShavingMilk", (0.16, 0.075, 0.038), rough=0.35),
    cherry=C.pbr("Cherry", (0.30, 0.004, 0.012), rough=0.08, coat=1.0, coat_rough=0.03, sss=0.3,
                 sss_radius=(1.0, 0.1, 0.1), sss_scale=0.003),
    stem=C.pbr("CherryStem", (0.10, 0.07, 0.025), rough=0.55),
)


# ----------------------------------------------------------------------------- wedge layer generator
def wedge(name, z0f, z1f, r_max, mat, nr, nz, nth, cut_disp):
    """Closed wedge solid between height functions z0f(r, th) and z1f(r, th).
    cut_disp(r, z, side, kfrac) -> offset (m) along the cut face's outward normal."""
    bm = bmesh.new()
    cache = {}

    def V(i, j, k):
        if i == 0:
            j = 0
        key = (i, j, k)
        v = cache.get(key)
        if v is not None:
            return v
        r = r_max * i / nr
        th = -ALPHA + 2 * ALPHA * j / nth
        z0, z1 = z0f(r, th), z1f(r, th)
        z = z0 + (z1 - z0) * k / nz
        p = world(r, th, z)
        if (j == 0 or j == nth) and i > 0:
            side = 1 if j == nth else -1
            n = Vector((side * math.cos(ALPHA), math.sin(ALPHA), 0.0))
            p += n * cut_disp(r, z, side, k / nz)
        v = bm.verts.new(p)
        cache[key] = v
        return v

    def face(vs):
        out = []
        for v in vs:
            if v not in out:
                out.append(v)
        if len(out) >= 3:
            try:
                bm.faces.new(out)
            except ValueError:
                pass

    for i in range(nr):
        for j in range(nth):
            face([V(i, j, 0), V(i, j + 1, 0), V(i + 1, j + 1, 0), V(i + 1, j, 0)])      # bottom
            face([V(i, j, nz), V(i + 1, j, nz), V(i + 1, j + 1, nz), V(i, j + 1, nz)])  # top
    for i in range(nr):
        for k in range(nz):
            face([V(i, 0, k), V(i + 1, 0, k), V(i + 1, 0, k + 1), V(i, 0, k + 1)])
            face([V(i, nth, k), V(i, nth, k + 1), V(i + 1, nth, k + 1), V(i + 1, nth, k)])
    for j in range(nth):
        for k in range(nz):
            face([V(nr, j, k), V(nr, j + 1, k), V(nr, j + 1, k + 1), V(nr, j, k + 1)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = C.link(bpy.data.objects.new(name, me))
    obj.data.materials.append(mat)
    C.smooth(obj, 50)
    return obj


def interface(level):
    """Slightly wavy layer interfaces (the bottom and the very top stay flat)."""
    base = Z_LAYERS[level]
    if level in (0, len(Z_LAYERS) - 1):
        return lambda r, th: base
    return lambda r, th: base + 0.0011 * fbm2(r * 45 + level * 3.1, th * 6, 40 + level)


def sponge_disp(r, z, side, kf):
    # crumbly, torn surface: mostly inward, coarse bumps + random torn-out bits
    n = fbm2(r * 260, z * 260 + side * 50, 3, 3)
    torn = max(0.0, vnoise(r * 90, z * 90 + side * 13, 9) - 0.45) * 0.0016
    return -0.00028 * (1.0 + n) - torn


def ganache_disp(r, z, side, kf):
    return 0.0007 * math.sin(math.pi * kf) * (0.8 + 0.2 * vnoise(r * 120, side, 2)) * min(1.0, r / 0.01)


sponges, fillings = [], []
for li in range(5):
    is_sp = li % 2 == 0
    z0f, z1f = interface(li), interface(li + 1)
    if is_sp:
        sponges.append(wedge("Sponge%d" % li, z0f, z1f, R_SP, M["sponge"], nr=70, nz=16, nth=6,
                             cut_disp=sponge_disp))
    else:
        fillings.append(wedge("Filling%d" % li, z0f, z1f, R_SP, M["ganache"], nr=70, nz=4, nth=6,
                              cut_disp=ganache_disp))
sponge = C.join("CakeSponge", sponges)
filling = C.join("CakeFilling", fillings)
C.box_uv(sponge, 0.03)
C.box_uv(filling, 0.05)

# ----------------------------------------------------------------------------- frosting shell
step = 0.0014
prof = [(0.0, Z_FR_BOT), (R_FR_IN, Z_FR_BOT), (R_FR_IN, 0.0), (R_FR, 0.0)]
nzb = int(Z_EDGE / step)
prof += [(R_FR, Z_EDGE * k / nzb) for k in range(1, nzb + 1)]
ER = 0.0042
prof += C.arc(R_FR - ER, Z_EDGE, ER, 0, 90, 7)[1:]               # rounded top-back edge (lip)
ntop = int((R_FR - ER) / step)
prof += [((R_FR - ER) * (1 - k / ntop), Z_EDGE + ER - (Z_EDGE + ER - Z_FR_TOP) * min(1.0, k / 6))
         for k in range(1, ntop + 1)]
frost = C.revolve("CakeFrostingShell", prof, segments=46, angle=math.degrees(2 * ALPHA),
                  start=-90 - math.degrees(ALPHA), closed_profile=True, materials=[M["frosting"]],
                  smooth_angle=60)
frost.data.transform(Matrix.Translation((0, TIP_Y, 0)))


def saw(t, sharp=0.18):
    t = t - math.floor(t)
    return t / (1 - sharp) if t < 1 - sharp else (1 - t) / sharp


def knife_top(r, th):
    s = r * th                                    # arc length across the slice
    # two families of palette-knife strokes (around the cake / pulled across it), patchily mixed
    ph1 = r / 0.0115 + 1.1 * fbm2(s * 16, r * 9, 21, 2)
    ph2 = (s + 0.35 * r) / 0.0135 + 0.8 * fbm2(r * 14, s * 10, 23, 2)
    m = min(1.0, max(0.0, 0.5 + 1.8 * fbm2(r * 11, s * 11, 24, 2)))
    ridge = 0.0006 * ((saw(ph1) - 0.5) * m + (saw(ph2) - 0.5) * (1 - m))
    swoop = 0.0016 * fbm2(r * 20, s * 20, 22, 2)
    fade = min(1.0, r / 0.02)
    return (ridge + swoop) * fade


def knife_back(th, z):
    s = R_FR * th
    ph = z / 0.0052 + 0.35 * vnoise(s * 30, z * 10, 31)
    return 0.00032 * (saw(ph, 0.25) - 0.5) + 0.00055 * fbm2(s * 45, z * 45, 32, 2)


for v in frost.data.vertices:
    r, th = polar(v.co.x, v.co.y)
    z = v.co.z
    if z > Z_FR_BOT + 0.004 and r < R_FR - ER + 0.0005:                    # frosted top
        v.co.z += knife_top(r, th)
    elif r > R_FR - 0.0004 and 0.0008 < z <= Z_EDGE + 0.0001:              # scraped back wall
        d = knife_back(th, z) * min(1.0, z / 0.004)
        v.co.x += d * math.sin(th)
        v.co.y -= d * math.cos(th)
    elif r > R_FR - ER and z > Z_EDGE:                                      # rounded lip
        lift = 0.0006 * fbm2(R_FR * th * 40, 0, 33, 2)
        v.co.z += lift


def top_z(x, y):
    r, th = polar(x, y)
    return Z_FR_TOP + knife_top(r, th)


# ----------------------------------------------------------------------------- piped rosette (frosting)
ROS = Vector((0.0, TIP_Y - 0.098, 0.0))
ROS.z = top_z(ROS.x, ROS.y) - 0.001


def rosette(center, rad=0.0135, hgt=0.0125, ridges=8, twist=1.3, nphi=72, nh=20):
    bm = bmesh.new()
    rings = []
    for k in range(nh + 1):
        t = k / nh
        rr = rad * (1 - t) ** 0.75 * (1.0 + 0.04 * math.sin(t * 9))
        ring = []
        for i in range(nphi):
            phi = 2 * math.pi * i / nphi
            m = 1.0 + 0.2 * math.cos(ridges * (phi + twist * 2 * math.pi * t))
            ring.append(bm.verts.new(center + Vector((rr * m * math.cos(phi), rr * m * math.sin(phi),
                                                      hgt * (1 - (1 - t) ** 1.6)))))
        rings.append(ring)
    tipv = bm.verts.new(center + Vector((0, 0, hgt + 0.0012)))
    for k in range(nh):
        for i in range(nphi):
            j = (i + 1) % nphi
            bm.faces.new([rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]])
    for i in range(nphi):
        bm.faces.new([rings[-1][i], rings[-1][(i + 1) % nphi], tipv])
    bm.faces.new(rings[0][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("Rosette")
    bm.to_mesh(me)
    bm.free()
    o = C.link(bpy.data.objects.new("Rosette", me))
    o.data.materials.append(M["frosting"])
    C.smooth(o, 70)
    return o


ros = rosette(ROS)
frosting = C.join("CakeFrosting", [frost, ros])
C.box_uv(frosting, 0.04)

# ----------------------------------------------------------------------------- toppings
def shaving(name, length, width, curl_r, thick=0.0006, mat=None):
    bm = bmesh.new()
    nu, nv = 14, 3
    grid = []
    for a in range(nu + 1):
        u = length * a / nu
        ang = u / curl_r
        row = []
        for b in range(nv + 1):
            w = width * (b / nv - 0.5) * (1 - 0.35 * abs(a / nu - 0.5) * 2)   # tapered ends
            row.append(bm.verts.new((curl_r * math.sin(ang), w, curl_r * (1 - math.cos(ang)))))
        grid.append(row)
    for a in range(nu):
        for b in range(nv):
            bm.faces.new([grid[a][b], grid[a + 1][b], grid[a + 1][b + 1], grid[a][b + 1]])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = C.link(bpy.data.objects.new(name, me))
    o.data.materials.append(mat)
    sol = o.modifiers.new("Solid", "SOLIDIFY")
    sol.thickness = thick
    sol.offset = 0
    C.apply_modifiers(o)
    C.smooth(o, 60)
    return o


tops = []
placed = 0
tries = 0
while placed < 16 and tries < 400:
    tries += 1
    r = random.uniform(0.02, 0.118)
    th = random.uniform(-ALPHA * 0.8, ALPHA * 0.8)
    p = world(r, th, 0)
    if (p - Vector((ROS.x, ROS.y, 0))).length < 0.017:
        continue
    milk = random.random() < 0.3
    s = shaving("Shaving", random.uniform(0.008, 0.016) * min(1.0, r / 0.05 + 0.4),
                random.uniform(0.0025, 0.0045), random.uniform(0.0025, 0.006),
                mat=M["shaving_milk"] if milk else M["shaving"])
    s.rotation_euler = (random.uniform(-0.5, 0.5), random.uniform(-0.3, 0.3), random.uniform(0, 2 * math.pi))
    s.location = (p.x, p.y, top_z(p.x, p.y) + 0.0002)
    tops.append(s)
    placed += 1

# cherry on the rosette
CH_R = 0.0092
ch_c = Vector((ROS.x, ROS.y, ROS.z + 0.0125 + CH_R * 0.75))
bpy.ops.mesh.primitive_uv_sphere_add(segments=40, ring_count=24, radius=CH_R, location=ch_c)
cherry = bpy.context.active_object
cherry.name = "Cherry"
for v in cherry.data.vertices:          # cherry shape: slightly flattened, dimple at the stem
    co = v.co
    d = co.length
    top = max(0.0, co.z / CH_R)
    co.z *= 0.93
    co *= 1.0 - 0.10 * math.exp(-((1 - top) / 0.12) ** 2) * (top > 0.6)
    co.x *= 1.0 + 0.03 * math.sin(co.y * 300)
cherry.data.materials.append(M["cherry"])
C.smooth(cherry, 80)
# stem: tapered tube along a curved path
pts = [ch_c + Vector((0, 0, CH_R * 0.82)) + Vector((0.0015 * t * t * 9, -0.004 * t, 0.026 * t - 0.006 * t * t))
       for t in [i / 16 for i in range(17)]]
cu = bpy.data.curves.new("Stem", "CURVE")
cu.dimensions = "3D"
cu.bevel_depth = 0.00075
cu.bevel_resolution = 2
sp = cu.splines.new("POLY")
sp.points.add(len(pts) - 1)
for i, p in enumerate(pts):
    sp.points[i].co = (*p, 1.0)
    sp.points[i].radius = 1.0 - 0.35 * i / (len(pts) - 1)
stem_o = C.link(bpy.data.objects.new("Stem", cu))
C.set_active(stem_o)
bpy.ops.object.convert(target="MESH")
stem_o = bpy.context.active_object
stem_o.data.materials.append(M["stem"])
C.smooth(stem_o, 60)
topping = C.join("CakeTopping", tops + [cherry, stem_o])
C.box_uv(topping, 0.03)


# ----------------------------------------------------------------------------- crumbs (floor)
def crumb(name, size, loc, mat, flat=0.7, seed=0, subdiv=2):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=size, location=(0, 0, 0))
    o = bpy.context.active_object
    o.name = name
    for v in o.data.vertices:
        n = v.co.normalized()
        k = 1.0 + 0.3 * vnoise(n.x * 2.5 + seed, n.y * 2.5 + n.z * 2, seed) + 0.06 * vnoise(n.x * 6, n.z * 6, seed + 1)
        v.co = v.co * k
        v.co.z *= flat
    o.data.materials.append(mat)
    o.rotation_euler = (random.uniform(-0.4, 0.4), random.uniform(-0.4, 0.4), random.uniform(0, 6.28))
    o.location = loc
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    lowest = min((o.matrix_world @ v.co).z for v in o.data.vertices)
    if lowest < 0.0:                       # never below the floor
        o.location.z -= lowest - 0.00005
    C.smooth(o, 50)
    return o


crumbs = []
for k in range(11):
    side = random.choice((-1, 1))
    r = random.uniform(0.01, 0.12)
    off = random.uniform(0.006, 0.03)
    th = side * (ALPHA + off / max(r, 0.03))
    p = world(r, th, 0)
    s = random.uniform(0.0012, 0.0032)
    crumbs.append(crumb("Crumb", s, (p.x, p.y, s * 0.45), M["sponge"], seed=k))
for k in range(3):   # a few behind the back
    th = random.uniform(-ALPHA, ALPHA)
    p = world(R_FR + random.uniform(0.006, 0.02), th, 0)
    s = random.uniform(0.0012, 0.0025)
    crumbs.append(crumb("Crumb", s, (p.x, p.y, s * 0.45), M["sponge"], seed=20 + k))
crumbs_o = C.join("CakeCrumbs", crumbs)
C.box_uv(crumbs_o, 0.03)


# ----------------------------------------------------------------------------- squashed blob
def squashed():
    parts = []
    nr, nph = 26, 120

    def Rph(ph):
        return 0.086 * (1 + 0.11 * math.sin(3 * ph + 1.0) + 0.07 * math.sin(5 * ph + 2.3)
                        + 0.06 * vnoise(ph * 3, 0.5, 51))

    def H(r, ph):
        rho = r / Rph(ph)
        if rho >= 1:
            return 0.0
        base = 0.0115 * (1 - rho ** 2.2) ** 0.55
        lumps = 0.0035 * max(0.0, fbm2(r * 60 * math.cos(ph) + 9, r * 60 * math.sin(ph) + 9, 52, 3) + 0.2)
        y_ = r * math.sin(ph)
        smear = 0.0011 * math.sin(y_ * 700 + 3 * vnoise(r * math.cos(ph) * 25, y_ * 25, 53)) \
            * max(0.0, vnoise(y_ * 40, 0.3, 55) + 0.2)                                     # brush drag lines
        edge = 0.0015 * math.exp(-((rho - 0.9) / 0.06) ** 2)                            # pushed-out rim
        return max(0.0004, base + (lumps + smear) * (1 - rho ** 3) + edge)

    bm = bmesh.new()
    centre = bm.verts.new((0, 0, H(0.0, 0.0)))
    rings = []
    for i in range(1, nr + 1):
        ring = []
        for j in range(nph):
            ph = 2 * math.pi * j / nph
            r = Rph(ph) * (i / nr) ** 0.85 * (0.999 if i == nr else 1.0)
            z = H(r, ph) if i < nr else 0.0003
            ring.append(bm.verts.new((r * math.cos(ph), r * math.sin(ph), z)))
        rings.append(ring)
    for j in range(nph):
        bm.faces.new([centre, rings[0][j], rings[0][(j + 1) % nph]])
    for i in range(nr - 1):
        for j in range(nph):
            k = (j + 1) % nph
            bm.faces.new([rings[i][j], rings[i + 1][j], rings[i + 1][k], rings[i][k]])
    bot = bm.faces.new(rings[-1][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("SquashBlob")
    bm.to_mesh(me)
    bm.free()
    blob = C.link(bpy.data.objects.new("SquashBlob", me))
    for m in (M["frosting"], M["ganache"]):
        blob.data.materials.append(m)
    C.smooth(blob, 70)
    parts.append(blob)

    # exposed sponge chunks, half buried
    for k in range(13):
        ph = random.uniform(0, 2 * math.pi)
        r = random.uniform(0.0, 0.065)
        x, y = r * math.cos(ph), r * math.sin(ph)
        s = random.uniform(0.006, 0.015)
        h = H(r, ph)
        o = crumb("Chunk", s, (x, y, h - s * 0.25), M["sponge"], flat=0.55, seed=100 + k, subdiv=3)
        parts.append(o)
    # squished ganache pools
    for k in range(8):
        ph = random.uniform(0, 2 * math.pi)
        r = random.uniform(0.01, 0.065)
        o = crumb("Pool", random.uniform(0.008, 0.016), (r * math.cos(ph), r * math.sin(ph), H(r, ph) - 0.0012),
                  M["ganache"], flat=0.14, seed=200 + k, subdiv=3)
        o.scale = (random.uniform(1.0, 2.2), 1.0, 1.0)
        parts.append(o)
    # flattened cherry + stem lying in the mess
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=0.0095,
                                         location=(0.028, -0.022, 0.0))
    ch = bpy.context.active_object
    ch.scale = (1.25, 1.0, 0.42)
    ch.location.z = H(0.036, -0.67) + 0.0005
    ch.data.materials.append(M["cherry"])
    C.apply_modifiers(ch)
    bpy.ops.object.transform_apply(scale=True)
    C.smooth(ch, 80)
    parts.append(ch)
    for k in range(9):
        ph = random.uniform(0, 2 * math.pi)
        r = random.uniform(0.01, 0.075)
        s = shaving("Shaving", random.uniform(0.007, 0.013), random.uniform(0.0025, 0.004),
                    random.uniform(0.004, 0.012), mat=M["shaving"] if k % 3 else M["shaving_milk"])
        s.rotation_euler = (random.uniform(-0.3, 0.3), 0, random.uniform(0, 6.28))
        s.location = (r * math.cos(ph), r * math.sin(ph), H(r, ph) - 0.0005)
        parts.append(s)
    o = C.join("CakeSquashed", parts)
    C.box_uv(o, 0.03)
    # keep it within the 0.02 m height budget
    zmax = max(v.co.z for v in o.data.vertices)
    for v in o.data.vertices:
        if zmax > 0.02:
            v.co.z *= 0.02 / zmax
        v.co.z = max(0.0, v.co.z)
    return o


squash = squashed()
squash["hidden"] = True

# ----------------------------------------------------------------------------- root + export
parts = [sponge, filling, frosting, topping, crumbs_o, squash]
root = C.link(bpy.data.objects.new("Cake", None))
for p in parts:
    p.parent = root
    p.matrix_parent_inverse = root.matrix_world.inverted()


def bbox(o):
    ws = [o.matrix_world @ v.co for v in o.data.vertices]
    return [min(w[i] for w in ws) for i in range(3)], [max(w[i] for w in ws) for i in range(3)]


for p in parts:
    lo, hi = bbox(p)
    print("BBOX %-13s min=(%+.4f %+.4f %+.4f) max=(%+.4f %+.4f %+.4f)" % (p.name, *lo, *hi))
print("TRIS", C.tri_count(parts))
out = os.path.join(C.MODELS, "cake.glb")
size = C.export_glb(out, [root] + parts, extras=True)
print("EXPORTED", out, size, "bytes")

if RENDER:
    squash.hide_render = True
    png = os.path.join(C.HERE, "cake_preview.png")
    C.render_preview(png, target=(0.0, 0.0, 0.055), cam_dir=(1.0, 0.75, 0.55), distance=0.62,
                     res=(1200, 900), samples=128, focal=70, key_power=30)
    print("RENDERED", png)
    top = os.path.join(C.HERE, "cake_top_preview.png")
    C.render_top(top, center=(0.0, 0.0, 0.0), extent=0.22, res=(1200, 1200), samples=128)
    print("RENDERED", top)
    # lying on its +X cut face, as the app shows it after tipping (pivot = bottom edge tip->right corner)
    crumbs_o.hide_render = True
    pivot_a = world(0, 0, 0)
    pivot_b = world(R_FR, ALPHA, 0)
    axis = (pivot_b - pivot_a).normalized()
    root.matrix_world = (Matrix.Translation(pivot_a) @ Matrix.Rotation(-math.pi / 2, 4, axis)
                         @ Matrix.Translation(-pivot_a))
    bpy.context.view_layer.update()
    ly = os.path.join(C.HERE, "cake_lying_top_preview.png")
    ws = [sponge.matrix_world @ v.co for v in sponge.data.vertices]
    ctr = ((min(w.x for w in ws) + max(w.x for w in ws)) / 2, (min(w.y for w in ws) + max(w.y for w in ws)) / 2, 0)
    C.render_top(ly, center=ctr, extent=0.2, res=(1000, 1000), samples=96)
    print("RENDERED", ly)
    root.matrix_world = Matrix.Identity(4)
    bpy.context.view_layer.update()
    for p in parts:
        p.hide_render = p is not squash
    squash.hide_render = False
    sq = os.path.join(C.HERE, "cake_squashed_preview.png")
    C.render_preview(sq, target=(0.0, 0.0, 0.0), cam_dir=(1.0, 0.75, 0.75), distance=0.6,
                     res=(1200, 900), samples=96, focal=70, key_power=30)
    print("RENDERED", sq)
