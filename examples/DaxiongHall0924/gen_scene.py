#!/usr/bin/env python3
"""DaxiongHall0924: writes every .ssdl file and texture from one set of dimensions.

Coordinates: x east, y north, z up, metres. z = 0 is the lower plaza; the terrace the hall
stands on is TERRACE_Z higher and is reached by the broad front stairs (camera side = south).
Run:  python3 gen_scene.py   (needs Pillow)
"""
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
FONT_CANDIDATES = ["/mnt/c/Windows/Fonts/simkai.ttf", "C:/Windows/Fonts/simkai.ttf",
                   "/mnt/c/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/simhei.ttf"]

# ---------------------------------------------------------------- dimensions
TERRACE_Z = 1.44            # 12 steps x 0.12
STEP_N, STEP_RISE, STEP_RUN, STAIR_W = 12, 0.12, 0.45, 19.0
STAIR_Y0 = -STEP_N * STEP_RUN   # bottom of the flight
PLATFORM_Z = TERRACE_Z + 1.0    # top of the hall's stone base
HALL_Y = 36.0                   # hall centre
TERRACE_HX, TERRACE_D = 47.0, 72.0   # the walled upper courtyard
BODY_HX, BODY_HY = 14.5, 9.1    # lower storey column line (29 x 18.2)
FRONT_Y = HALL_Y - BODY_HY      # 26
UP_HX, UP_HY = 12.2, 6.8        # upper storey wall (24.4 x 13.6)
COL_TOP = PLATFORM_Z + 4.8
LOW_EAVE_Z = COL_TOP + 0.75
UP_WALL_Z0, UP_WALL_Z1 = LOW_EAVE_Z + 2.7, LOW_EAVE_Z + 4.9
UP_EAVE_Z = UP_WALL_Z1 + 0.6
UP_ROOF_H = 6.8
BAYS = [3.6, 4.0, 4.2, 5.4, 4.2, 4.0, 3.6]


# ---------------------------------------------------------------- tiny vector kit
def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def mul(a, s): return (a[0] * s, a[1] * s, a[2] * s)
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def length(a): return math.sqrt(dot(a, a))


def num(v):
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "", "-") else s


def vec(v): return "[" + ",".join(num(x) for x in v) + "]"
def vlist(pts): return "[" + ",".join(vec(p) for p in pts) + "]"
def slist(xs): return "[" + ",".join(num(x) for x in xs) + "]"
def qz(deg):
    h = math.radians(deg) / 2
    return [0, 0, math.sin(h), math.cos(h)]


def material(color, rough=0.85, tex=None, metal=None, extra=""):
    parts = [f'baseColor: "{color}"', f"roughness: {num(rough)}"]
    if tex:
        parts.append(f"baseColorMap: {tex}")
        if tex == "leafTex":
            parts.append("uvScale: [4, 4]")
    if metal is not None:
        parts.append(f"metalness: {num(metal)}")
    if extra:
        parts.append(extra)
    return "PrincipledMaterial { " + "; ".join(parts) + " }"


def box(id_, size, pos, mat, rot=None, visible=True):
    r = f"; rotation: {vec(rot)}" if rot else ""
    v = "" if visible else "; visible: false"
    return (f"Box {{ id: {id_}; width: {num(size[0])}; depth: {num(size[1])}; height: {num(size[2])}; "
            f"position: {vec(pos)}{r}{v}; {mat} }}")


# ---------------------------------------------------------------- mesh builder
class MeshBuilder:
    def __init__(self):
        self.v, self.uv, self.f = [], [], []

    def vert(self, p, uv=(0.0, 0.0)):
        self.v.append(tuple(round(c, 3) for c in p))
        self.uv.append(tuple(uv))
        return len(self.v) - 1

    def tri(self, a, b, c, outward=None):
        pa, pb, pc = self.v[a], self.v[b], self.v[c]
        n = cross(sub(pb, pa), sub(pc, pa))
        if length(n) < 2e-4:
            return
        if outward is not None and dot(n, outward) < 0:
            b, c = c, b
        self.f.append((a, b, c))

    def quad(self, a, b, c, d, outward):
        self.tri(a, b, c, outward)
        self.tri(a, c, d, outward)

    def rect(self, p0, p1, p2, p3, outward, uv=((0, 0), (1, 0), (1, 1), (0, 1))):
        """p0 bottom-left, p1 bottom-right, p2 top-right, p3 top-left seen from outside."""
        ids = [self.vert(p, t) for p, t in zip((p0, p1, p2, p3), uv)]
        self.quad(*ids, outward)

    def box(self, c, s, yaw=0.0):
        hx, hy, hz = s[0] / 2, s[1] / 2, s[2] / 2
        cy, sy = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))

        def P(x, y, z): return (c[0] + x * cy - y * sy, c[1] + x * sy + y * cy, c[2] + z)

        def D(x, y, z): return (x * cy - y * sy, x * sy + y * cy, z)
        faces = [
            ((-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz), (-hx, -hy, hz), D(0, -1, 0)),
            ((hx, hy, -hz), (-hx, hy, -hz), (-hx, hy, hz), (hx, hy, hz), D(0, 1, 0)),
            ((hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz), (hx, -hy, hz), D(1, 0, 0)),
            ((-hx, hy, -hz), (-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, hz), D(-1, 0, 0)),
            ((-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz), (0, 0, 1)),
            ((-hx, hy, -hz), (hx, hy, -hz), (hx, -hy, -hz), (-hx, -hy, -hz), (0, 0, -1)),
        ]
        for a, b, cc, d, n in faces:
            self.rect(P(*a), P(*b), P(*cc), P(*d), n)

    def prism(self, poly, origin, U, V, W, thick, uv_scale=1.0):
        """Polygon (u, v) in the plane origin + u*U + v*V, extruded +-thick/2 along W."""
        area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
                   for i in range(len(poly)))
        if area < 0:
            poly = poly[::-1]

        def P(u, v, w): return add(add(add(origin, mul(U, u)), mul(V, v)), mul(W, w))
        tris = ear_clip(poly)
        for sign in (-1, 1):
            ids = [self.vert(P(u, v, sign * thick / 2), (u * uv_scale, -v * uv_scale)) for u, v in poly]
            for a, b, c in tris:
                self.tri(ids[a], ids[b], ids[c], mul(W, sign))
        n = len(poly)
        for i in range(n):
            (u0, v0), (u1, v1) = poly[i], poly[(i + 1) % n]
            out = add(mul(U, v1 - v0), mul(V, -(u1 - u0)))
            L = math.hypot(u1 - u0, v1 - v0)
            self.rect(P(u0, v0, -thick / 2), P(u1, v1, -thick / 2), P(u1, v1, thick / 2), P(u0, v0, thick / 2), out,
                      ((0, 0), (L * uv_scale, 0), (L * uv_scale, thick * uv_scale), (0, thick * uv_scale)))

    def lathe(self, prof, c=(0, 0, 0), segs=12, axis="z"):
        """Revolve [(r, h)] (bottom to top) around an axis through c: 'z' vertical, 'x'/'y' horizontal."""
        rings = []
        for r, hh in prof:
            ring = []
            for k in range(segs + 1):
                a = 2 * math.pi * k / segs
                ca, sa = math.cos(a) * r, math.sin(a) * r
                if axis == "z":
                    q = (ca, sa, hh)
                elif axis == "y":
                    q = (ca, hh, -sa)
                else:
                    q = (hh, sa, -ca)
                ring.append(self.vert(add(c, q), (k / segs, hh)))
            rings.append(ring)
        for i in range(len(prof) - 1):
            for k in range(segs):
                a, b = rings[i][k], rings[i][k + 1]
                cc, dd = rings[i + 1][k + 1], rings[i + 1][k]
                self.tri(a, b, cc)
                self.tri(a, cc, dd)

    def bar(self, p0, p1, w, h, up=(0, 0, 1)):
        """Box of section w x h running from p0 to p1 (a rafter, a rail, a brace)."""
        dv = sub(p1, p0)
        L = length(dv)
        dv = mul(dv, 1 / L)
        sd = cross(dv, up)
        if length(sd) < 1e-6:
            sd = (1, 0, 0)
        sd = mul(sd, 1 / length(sd))
        uv_ = cross(sd, dv)

        def P(p, a, b): return add(add(p, mul(sd, a * w / 2)), mul(uv_, b * h / 2))
        c = [P(p0, -1, -1), P(p0, 1, -1), P(p0, 1, 1), P(p0, -1, 1),
             P(p1, -1, -1), P(p1, 1, -1), P(p1, 1, 1), P(p1, -1, 1)]
        for (i, j), out in (((0, 1), mul(uv_, -1)), ((1, 2), sd), ((2, 3), uv_), ((3, 0), mul(sd, -1))):
            self.rect(c[i], c[j], c[j + 4], c[i + 4], out, ((0, 0), (1, 0), (1, L), (0, L)))
        self.rect(c[0], c[1], c[2], c[3], mul(dv, -1))
        self.rect(c[4], c[5], c[6], c[7], dv)

    def extend(self, other):
        base = len(self.v)
        self.v += other.v
        self.uv += other.uv
        self.f += [(a + base, b + base, c + base) for a, b, c in other.f]

    def transformed(self, fn):
        m = MeshBuilder()
        m.v = [fn(p) for p in self.v]
        m.uv = list(self.uv)
        m.f = list(self.f)
        return m

    def ssdl(self, id_, mat, shading="flat", uvs=True, visible=True, extra=""):
        assert len(self.v) <= 21845, f"{id_}: {len(self.v)} vertices"
        used = sorted({i for t in self.f for i in t})
        remap = {o: n for n, o in enumerate(used)}
        verts = [c for i in used for c in self.v[i]]
        faces = [remap[i] for t in self.f for i in t]
        parts = [f"id: {id_}", f"vertices: {slist(verts)}", "faces: [" + ",".join(str(i) for i in faces) + "]"]
        if uvs:
            parts.append(f"uvs: {slist([c for i in used for c in self.uv[i]])}")
        parts.append(f'shading: "{shading}"')
        if not visible:
            parts.append("visible: false")
        if extra:
            parts.append(extra)
        parts.append(mat)
        return "Mesh { " + "; ".join(parts) + " }"


def ear_clip(poly):
    idx = list(range(len(poly)))
    tris = []

    def cr(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def inside(p, a, b, c):
        return cr(a, b, p) > 1e-9 and cr(b, c, p) > 1e-9 and cr(c, a, p) > 1e-9
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        # drop collinear / zero-length corners first; they never form an ear
        for k in range(len(idx)):
            a, b, c = poly[idx[k - 1]], poly[idx[k]], poly[idx[(k + 1) % len(idx)]]
            if abs(cr(a, b, c)) < 1e-9:
                idx.pop(k)
                break
        else:
            pass
        if len(idx) <= 3:
            break
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = poly[i0], poly[i1], poly[i2]
            if cr(a, b, c) <= 1e-9:
                continue
            if any(inside(poly[j], a, b, c) for j in idx if j not in (i0, i1, i2)):
                continue
            tris.append((i0, i1, i2))
            idx.pop(k)
            break
    tris.append(tuple(idx))
    return tris


# ---------------------------------------------------------------- the roof generator
def curved_roof(A, B, z0, H, d_end, d_gable=None, lift=0.8, flare=0.6, decay=None, thick=0.35,
                nd=18, ns=56, p=(0.55, 0.45), ridge=True):
    """Hip (d_gable None), hip-gable, or skirt roof with concave slopes and upturned corners.

    Canonical frame: centre at the origin, long sides facing -y/+y, ends facing +-x.
    Ring at inset d is the rectangle (A - d) x (B - d) at height zf(d); the ends stop shrinking
    past d_gable (the gable part of a hip-gable roof). Returns meshes and ridge polylines.
    """
    dg = d_end if d_gable is None else d_gable
    decay = min(decay or d_end * 0.75, dg if d_gable is not None else 1e9)

    def zf(d):
        u = d / d_end
        return z0 + H * (p[0] * u + p[1] * u * u)

    def curve(d):
        k = max(0.0, 1.0 - d / decay) if decay > 0 else 0.0
        return lift * k * k, flare * k * k

    def ds_range(lo, hi, n):
        return [lo + (hi - lo) * i / n for i in range(n + 1)]
    if d_gable is not None and 0.05 < d_gable < d_end:
        n1 = max(4, int(nd * d_gable / d_end))
        long_ds = ds_range(0, d_gable, n1) + ds_range(d_gable, d_end, max(3, nd - n1))[1:]
    else:
        long_ds = ds_range(0, d_end, nd)
    end_hi = min(dg, d_end)
    end_ds = ds_range(0, end_hi, max(3, int(nd * end_hi / d_end))) if end_hi > 0.05 else []

    def pt_long(d, s, side):  # side -1 = south (y<0), +1 = north
        a = A - min(d, dg)
        lz, fl = curve(d)
        w = abs(s) ** 3
        x = s * a + math.copysign(fl * w, s)
        y = side * ((B - d) + fl * w)
        return (x, y, zf(d) + lz * w)

    def pt_end(d, s, side):  # side +1 = east (x>0)
        b = B - d
        lz, fl = curve(d)
        w = abs(s) ** 3
        x = side * ((A - d) + fl * w)
        y = s * b + math.copysign(fl * w, s)
        return (x, y, zf(d) + lz * w)

    top, under, fascia = MeshBuilder(), MeshBuilder(), MeshBuilder()
    ss = [-1 + 2 * i / ns for i in range(ns + 1)]
    grids = []
    for side in (-1, 1):
        grids.append(([[pt_long(d, s, side) for s in ss] for d in long_ds], (0, side, 0), 0))
    for side in (-1, 1):
        if end_ds:
            grids.append(([[pt_end(d, s, side) for s in ss] for d in end_ds], (side, 0, 0), 1))
    for rows, out, axis in grids:
        # v = slope distance along the middle of the side
        vs = [0.0]
        for i in range(1, len(rows)):
            vs.append(vs[-1] + length(sub(rows[i][ns // 2], rows[i - 1][ns // 2])))
        for mb, dz, orient in ((top, 0.0, (0, 0, 1)), (under, -thick, (0, 0, -1))):
            ids = [[mb.vert((p_[0], p_[1], p_[2] + dz), (p_[axis], vs[i])) for p_ in row] for i, row in enumerate(rows)]
            for i in range(len(rows) - 1):
                for j in range(ns):
                    mb.quad(ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j], orient)
        # fascia along the eave (row 0)
        row = rows[0]
        for j in range(ns):
            a, b = row[j], row[j + 1]
            ia = fascia.vert(a, (a[axis], 0)); ib = fascia.vert(b, (b[axis], 0))
            ja = fascia.vert((a[0], a[1], a[2] - thick), (a[axis], thick))
            jb = fascia.vert((b[0], b[1], b[2] - thick), (b[axis], thick))
            fascia.quad(ia, ib, jb, ja, out)
        if axis == 0 and d_gable is not None and d_gable < d_end:
            # barge boards along the gable part of the long sides
            gi = [i for i, d in enumerate(long_ds) if d >= d_gable - 1e-9]
            for jj, sx in ((0, -1), (ns, 1)):
                for i0, i1 in zip(gi, gi[1:]):
                    a, b = rows[i0][jj], rows[i1][jj]
                    ia = fascia.vert(a); ib = fascia.vert(b)
                    ja = fascia.vert((a[0], a[1], a[2] - thick)); jb = fascia.vert((b[0], b[1], b[2] - thick))
                    fascia.quad(ia, ib, jb, ja, (sx, 0, 0))
    hips = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            hips.append([(sx * p_[0], sy * p_[1], p_[2]) for p_ in
                         [pt_long(d, 1.0, 1) for d in long_ds if d <= min(dg, d_end) + 1e-9]])
    verges = []
    if d_gable is not None and d_gable < d_end:
        for sx in (-1, 1):
            for sy in (-1, 1):
                verges.append([(sx * p_[0], sy * p_[1], p_[2]) for p_ in
                               [pt_long(d, 1.0, 1) for d in long_ds if d >= d_gable - 1e-9]])
    ridge_half = A - dg if ridge else None
    return dict(top=top, under=under, fascia=fascia, hips=hips, verges=verges, zf=zf,
                ridge_half=ridge_half, ridge_z=zf(d_end), dg=dg, A=A, B=B, d_end=d_end, curve=curve,
                pt_long=pt_long, pt_end=pt_end, long_ds=long_ds, end_ds=end_ds, thick=thick)


def gable_face(A, B, dg, zf, d_end, inset, drop=0.4, thick=0.2):
    """Vertical pediment under a hip-gable roof's gable part, both ends. uv in metres."""
    xg = A - dg - inset
    mb = MeshBuilder()
    for sx in (-1, 1):
        n = 12
        poly = [(-(B - dg), zf(dg) - drop)]
        for i in range(n + 1):
            d = dg + (d_end - dg) * i / n
            poly.append((-(B - d), zf(d) - 0.36))
        for i in range(n - 1, -1, -1):
            d = dg + (d_end - dg) * i / n
            poly.append(((B - d), zf(d) - 0.36))
        poly.append(((B - dg), zf(dg) - drop))
        # drop consecutive duplicates (the apex)
        clean = []
        for q in poly:
            if not clean or math.hypot(q[0] - clean[-1][0], q[1] - clean[-1][1]) > 1e-4:
                clean.append(q)
        mb.prism(clean, (sx * xg, 0, 0), (0, 1, 0), (0, 0, 1), (1, 0, 0), thick, uv_scale=1 / 3.0)
    return mb


def rot90(mb):  # canonical ridge-along-x -> ridge-along-y (proper rotation keeps the winding)
    return mb.transformed(lambda p: (-p[1], p[0], p[2]))


def rot90_pts(pts): return [(-p[1], p[0], p[2]) for p in pts]


HIP_PROFILE = [[-0.22, 0, -0.12], [0.22, 0, -0.12], [0.22, 0, 0.1], [0.16, 0, 0.16], [0.16, 0, 0.3],
               [0.1, 0, 0.37], [-0.1, 0, 0.37], [-0.16, 0, 0.3], [-0.16, 0, 0.16], [-0.22, 0, 0.1]]


def scaled_profile(k): return [[x * k, 0, z * k] for x, _, z in HIP_PROFILE]


def hip_ridge_path(path, curl=0.9, rise=0.55):
    """Hip ridge along a corner line, raised a little, with an upturned tip past the eave."""
    pts = [(p[0], p[1], p[2] + 0.1) for p in path]
    a, b = pts[0], pts[1]
    dxy = (a[0] - b[0], a[1] - b[1])
    L = math.hypot(*dxy)
    tip = (a[0] + dxy[0] / L * curl, a[1] + dxy[1] / L * curl, a[2] + rise)
    mid = (a[0] + dxy[0] / L * curl * 0.5, a[1] + dxy[1] / L * curl * 0.5, a[2] + rise * 0.3)
    out = [tip, mid] + pts
    # thin out: keep every other interior point to stay well under 256
    return out


def sweep(id_, path, mat, profile=HIP_PROFILE):
    return (f"Sweep {{ id: {id_}; profile: {vlist(profile)}; path: {vlist(path)}; cap: true; flat: true; "
            f'smooth: "catmullrom"; samples: 2; {mat} }}')


def chiwen(mb, x_end, z, outward):
    """Ridge-end ornament: an extruded curling silhouette, facing the ridge axis."""
    sil = [(-0.75, 0), (0.45, 0), (0.62, 0.35), (0.6, 0.85), (0.42, 1.3), (0.12, 1.62), (-0.25, 1.72),
           (-0.55, 1.55), (-0.62, 1.3), (-0.4, 1.38), (-0.18, 1.3), (-0.05, 1.05), (-0.3, 0.8), (-0.62, 0.62)]
    poly = [(u * outward, v) for u, v in sil]
    mb.prism(poly, (x_end, 0, z), (1, 0, 0), (0, 0, 1), (0, 1, 0), 0.42)


# ---------------------------------------------------------------- textures
def _emboss(height, base, strength=2.2, light=(-1, -1)):
    """Shade a height map (0..1 float array) as carved relief lit from the upper left."""
    import numpy as np
    gx = np.roll(height, light[0], axis=1) - np.roll(height, -light[0], axis=1)
    gy = np.roll(height, light[1], axis=0) - np.roll(height, -light[1], axis=0)
    shade = 1.0 + strength * (gx + gy) - 0.18 * (1 - height)
    out = np.clip(np.array(base, dtype=float)[None, None, :] * shade[..., None], 0, 255)
    return Image.fromarray(out.astype("uint8"), "RGB")


def _grain(img, rnd, amount=10, streak=True):
    """Wood grain / weathering: vertical streaks plus fine noise."""
    import numpy as np
    a = np.asarray(img).astype(float)
    h, w = a.shape[:2]
    n = np.random.default_rng(rnd.randint(0, 1 << 30))
    noise = n.normal(0, amount * 0.35, (h, w))
    if streak:
        cols = n.normal(0, amount * 0.6, (1, w))
        noise = noise + np.repeat(cols, h, axis=0)
    a = np.clip(a + noise[..., None], 0, 255)
    return Image.fromarray(a.astype("uint8"), "RGB")


def _lattice(d, box, step, col, width=3, circles=True):
    """三交六椀-style lattice: verticals plus +-60 degree bars, small rosettes at the crossings."""
    x0, y0, x1, y1 = box
    t = math.tan(math.radians(60))
    x = x0
    while x <= x1:
        d.line([(x, y0), (x, y1)], fill=col, width=width)
        x += step
    h = y1 - y0
    k = -int(h / t / step) - 2
    while x0 + k * step < x1 + h / t:
        xa = x0 + k * step
        for sgn in (1, -1):
            pts = []
            for yy in (y0, y1):
                xx = xa + sgn * (yy - y0) / t
                pts.append((xx, yy))
            d.line(pts, fill=col, width=width)
        k += 1
    if circles:
        x = x0
        while x <= x1:
            yy = y0
            while yy <= y1:
                d.ellipse([x - 3, yy - 3, x + 3, yy + 3], outline=col, width=2)
                yy += step * t / 2
            x += step


def write_textures():
    import numpy as np
    os.makedirs(ASSETS, exist_ok=True)
    rnd = random.Random(7)

    # roof tiles for the flanking buildings: 1 m x 1 m, u along the eave, v down the slope, painted rolls.
    W = 256
    img = Image.new("RGB", (W, W), (110, 104, 97))
    d = ImageDraw.Draw(img)
    for k in range(4):
        x0 = k * 64
        for x in range(x0, x0 + 64):
            t = (x - x0) / 64.0
            if 0.12 < t < 0.5:
                c = math.sin((t - 0.12) / 0.38 * math.pi)
                g = int(104 + 60 * c)
                d.line([(x, 0), (x, W)], fill=(g + 6, g + 1, g - 6))
            else:
                g = 86 + int(10 * math.sin(t * 6.28))
                d.line([(x, 0), (x, W)], fill=(g + 4, g, g - 5))
        for y in range(0, W, 32):
            d.line([(x0 + 8, y), (x0 + 30, y)], fill=(70, 66, 60), width=2)
    img = _grain(img.filter(ImageFilter.GaussianBlur(0.6)), rnd, 6, streak=False)
    img.save(os.path.join(ASSETS, "tiles.png"))

    # pan tiles under the modelled cover-tile rolls of the main hall: 3 channels per metre, overlapping courses.
    W = 384
    h = np.zeros((W, W))
    xs = (np.arange(W) % 128) / 128.0
    chan = 0.5 - 0.5 * np.cos(xs * 2 * math.pi)          # concave channel between rolls
    ys = (np.arange(W) % 48) / 48.0
    course = np.clip(ys * 1.4, 0, 1)                    # each course overlaps the next one down
    h = chan[None, :] * 0.55 + course[:, None] * 0.45
    img = _emboss(h, (104, 100, 95), strength=1.6)
    img = _grain(img, rnd, 7, streak=False)
    img.save(os.path.join(ASSETS, "pantiles.png"))

    # soffit with rafters: 1 m repeat, rafters every 0.25 m, painted ends
    img = Image.new("RGB", (128, 128), (70, 46, 32))
    d = ImageDraw.Draw(img)
    for k in range(4):
        d.rectangle([k * 32 + 6, 0, k * 32 + 22, 128], fill=(128, 70, 44))
        d.line([(k * 32 + 7, 0), (k * 32 + 7, 128)], fill=(150, 90, 58), width=2)
    _grain(img, rnd, 8).save(os.path.join(ASSETS, "rafters.png"))

    # paving: 4 m x 4 m, 0.5 m slabs, warm granite with worn centres
    W = 512
    img = Image.new("RGB", (W, W), (150, 144, 134))
    d = ImageDraw.Draw(img)
    for i in range(8):
        for j in range(8):
            t = rnd.uniform(-12, 10)
            base = (206 + t, 198 + t, 184 + t)
            d.rectangle([i * 64 + 1, j * 64 + 1, i * 64 + 62, j * 64 + 62], fill=tuple(int(c) for c in base))
            for _ in range(70):
                px, py = i * 64 + rnd.randint(2, 61), j * 64 + rnd.randint(2, 61)
                s = rnd.uniform(-18, 8)
                d.point((px, py), fill=tuple(int(c + s) for c in base))
    img = _grain(img.filter(ImageFilter.GaussianBlur(0.4)), rnd, 8, streak=False)
    img.save(os.path.join(ASSETS, "paving.png"))

    # door bay: four closed 格扇 leaves. Top to bottom: lattice heart, 绦环板, 裙板, 绦环板.
    wood, dark, bar = (122, 78, 46), (38, 26, 19), (158, 108, 66)
    img = Image.new("RGB", (1024, 1024), wood)
    d = ImageDraw.Draw(img)
    for k in range(4):
        x0, x1 = k * 256 + 10, k * 256 + 246
        d.rectangle([k * 256, 0, k * 256 + 255, 1023], fill=wood)
        d.rectangle([x0 + 14, 26, x1 - 14, 560], fill=dark)
        _lattice(d, (x0 + 14, 26, x1 - 14, 560), 26, bar, width=4)
        d.rectangle([x0 + 14, 26, x1 - 14, 560], outline=(96, 60, 36), width=6)
        d.rectangle([x0 + 22, 596, x1 - 22, 664], outline=(82, 52, 32), width=5)
        d.ellipse([x0 + 70, 606, x1 - 70, 654], outline=(170, 130, 70), width=3)
        d.rectangle([x0 + 22, 700, x1 - 22, 930], outline=(82, 52, 32), width=6)
        d.rounded_rectangle([x0 + 44, 724, x1 - 44, 906], radius=30, outline=(170, 130, 70), width=4)
        d.ellipse([x0 + 88, 772, x1 - 88, 858], outline=(170, 130, 70), width=4)
        d.rectangle([x0 + 22, 956, x1 - 22, 1004], outline=(82, 52, 32), width=5)
        d.line([(k * 256 + 2, 0), (k * 256 + 2, 1023)], fill=(60, 38, 24), width=4)
    _grain(img, rnd, 9).save(os.path.join(ASSETS, "door_bay.png"))

    # window bay (槛窗): four lattice leaves over a 绦环板 strip; the sill wall below is geometry
    img = Image.new("RGB", (1024, 512), wood)
    d = ImageDraw.Draw(img)
    for k in range(4):
        x0, x1 = k * 256 + 10, k * 256 + 246
        d.rectangle([x0 + 14, 22, x1 - 14, 400], fill=dark)
        _lattice(d, (x0 + 14, 22, x1 - 14, 400), 26, bar, width=4)
        d.rectangle([x0 + 14, 22, x1 - 14, 400], outline=(96, 60, 36), width=6)
        d.rectangle([x0 + 22, 430, x1 - 22, 492], outline=(82, 52, 32), width=5)
        d.ellipse([x0 + 70, 440, x1 - 70, 482], outline=(170, 130, 70), width=3)
        d.line([(k * 256 + 2, 0), (k * 256 + 2, 511)], fill=(60, 38, 24), width=4)
    _grain(img, rnd, 9).save(os.path.join(ASSETS, "window_bay.png"))

    # transom / upper-storey lattice strip (步步锦): 3 m x 1 m repeat
    img = Image.new("RGB", (768, 256), wood)
    d = ImageDraw.Draw(img)
    for k in range(3):
        x0 = k * 256 + 14
        d.rectangle([x0, 22, x0 + 228, 234], fill=dark)
        for r in range(4):
            inset = 12 + r * 22
            d.rectangle([x0 + inset, 22 + inset * 0.8, x0 + 228 - inset, 234 - inset * 0.8], outline=bar, width=4)
        for x in (x0 + 57, x0 + 114, x0 + 171):
            d.line([(x, 22), (x, 234)], fill=bar, width=4)
        d.line([(x0, 128), (x0 + 228, 128)], fill=bar, width=4)
        d.rectangle([x0, 22, x0 + 228, 234], outline=(96, 60, 36), width=7)
    _grain(img, rnd, 8).save(os.path.join(ASSETS, "lattice_strip.png"))

    # painted beam (旋子彩画): one bay per texture, u across the bay. 箍头 | 藻头 旋花 | 枋心 | mirrored.
    Wb, Hb = 1024, 128
    img = Image.new("RGB", (Wb, Hb), (40, 78, 84))
    d = ImageDraw.Draw(img)
    gold, blue, green, red = (206, 164, 78), (38, 64, 104), (44, 96, 78), (132, 40, 28)
    for side in (0, 1):
        def X(x): return x if side == 0 else Wb - 1 - x
        def R(a, b): return [min(X(a), X(b)), 0, max(X(a), X(b)), Hb]
        d.rectangle(R(0, 60), fill=blue)
        d.rectangle(R(18, 26), fill=gold); d.rectangle(R(44, 50), fill=gold)
        d.rectangle(R(60, 300), fill=green)
        for cx in (130, 230):
            c = X(cx)
            for rr, colr in ((50, gold), (44, blue), (30, gold), (25, (230, 226, 214)), (12, red)):
                d.ellipse([c - rr, Hb / 2 - rr, c + rr, Hb / 2 + rr], fill=colr)
            for a in range(0, 360, 45):
                ax, ay = c + 38 * math.cos(math.radians(a)), Hb / 2 + 38 * math.sin(math.radians(a))
                d.ellipse([ax - 6, ay - 6, ax + 6, ay + 6], fill=(60, 110, 140))
        d.polygon([(X(300), 0), (X(340), Hb / 2), (X(300), Hb)], fill=gold)
    d.rectangle([346, 10, Wb - 346, Hb - 10], fill=blue)
    d.rectangle([346, 10, Wb - 346, Hb - 10], outline=gold, width=5)
    for k in range(6):
        cx = 380 + k * 52
        d.arc([cx - 20, 34, cx + 20, 94], 200, 340, fill=gold, width=3)
        d.arc([cx - 12, 44, cx + 12, 84], 20, 160, fill=gold, width=3)
    d.line([(0, 3), (Wb, 3)], fill=gold, width=5); d.line([(0, Hb - 4), (Wb, Hb - 4)], fill=gold, width=5)
    _grain(img, rnd, 6, streak=False).save(os.path.join(ASSETS, "beam_paint.png"))

    # carved stone balustrade panel (华板): relief from a height map, 1 bay wide
    Wp, Hp = 512, 192
    hm = Image.new("L", (Wp, Hp), 0)
    d = ImageDraw.Draw(hm)
    d.rectangle([0, 0, Wp, Hp], fill=210)
    d.rectangle([18, 18, Wp - 18, Hp - 18], fill=120)                 # recessed field
    d.rounded_rectangle([34, 30, Wp - 34, Hp - 30], radius=26, outline=235, width=8)
    cx, cy = Wp // 2, Hp // 2
    for rr, v in ((62, 230), (48, 150), (40, 235), (18, 150), (12, 240)):
        d.ellipse([cx - rr, cy - rr * 0.9, cx + rr, cy + rr * 0.9], fill=v)
    for a in range(0, 360, 30):
        ax, ay = cx + 54 * math.cos(math.radians(a)), cy + 48 * math.sin(math.radians(a))
        d.ellipse([ax - 9, ay - 9, ax + 9, ay + 9], fill=240)
    for sgn in (-1, 1):                                                 # cloud scrolls
        for k in range(3):
            x = cx + sgn * (110 + k * 48)
            d.arc([x - 26, cy - 30, x + 26, cy + 22], 180, 360 if sgn > 0 else 540, fill=235, width=9)
            d.ellipse([x - 8, cy - 4, x + 8, cy + 12], fill=235)
    hm = hm.filter(ImageFilter.GaussianBlur(2.2))
    h = np.asarray(hm).astype(float) / 255.0
    img = _emboss(h, (214, 209, 198), strength=3.0)
    _grain(img, rnd, 7, streak=False).save(os.path.join(ASSETS, "rail_panel.png"))

    # plain weathered stone for posts, drum stones, bases
    img = Image.new("RGB", (256, 256), (212, 207, 196))
    img = _grain(img, rnd, 14, streak=False).filter(ImageFilter.GaussianBlur(0.8))
    img = _grain(img, rnd, 5, streak=False)
    img.save(os.path.join(ASSETS, "stone.png"))

    # grey brick: 1 m x 1 m
    img = Image.new("RGB", (256, 256), (150, 148, 142))
    d = ImageDraw.Draw(img)
    for r in range(16):
        off = 32 if r % 2 else 0
        for c in range(-1, 5):
            t = rnd.uniform(-10, 10)
            d.rectangle([c * 64 + off + 2, r * 16 + 2, c * 64 + off + 62, r * 16 + 14],
                        fill=(int(128 + t), int(128 + t), int(126 + t)))
    _grain(img, rnd, 6, streak=False).save(os.path.join(ASSETS, "brick.png"))

    # white plaster with red timber frame: 3 m x 3 m
    img = Image.new("RGB", (384, 384), (236, 230, 216))
    d = ImageDraw.Draw(img)
    red = (150, 42, 30)
    for x in (0, 192):
        d.rectangle([x, 0, x + 22, 384], fill=red)
    for y in (0, 192):
        d.rectangle([0, y, 384, y + 18], fill=red)
    for x in (96, 288):
        d.rectangle([x - 4, 18, x + 4, 192], fill=red)
    img = _grain(img, rnd, 6, streak=False)
    img.save(os.path.join(ASSETS, "timber_wall.png"))

    # foliage: clumpy noise
    W = 256
    img = Image.new("RGB", (W, W), (150, 150, 150))
    d = ImageDraw.Draw(img)
    for _ in range(2600):
        x, y, r = rnd.randint(0, W), rnd.randint(0, W), rnd.randint(2, 7)
        s = rnd.uniform(-1, 1)
        g = int(190 + 60 * s)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(g, g, g))
    img = img.filter(ImageFilter.GaussianBlur(0.8))
    img.save(os.path.join(ASSETS, "foliage.png"))

    # meadow / undergrowth for the valley floor and the slopes under the trees
    W = 512
    img = Image.new("RGB", (W, W), (70, 86, 46))
    d = ImageDraw.Draw(img)
    for _ in range(9000):
        x, y, r = rnd.randint(0, W), rnd.randint(0, W), rnd.randint(1, 5)
        g = rnd.uniform(-1, 1)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(int(78 + 22 * g), int(96 + 22 * g), int(50 + 10 * g)))
    for _ in range(300):
        x, y, r = rnd.randint(0, W), rnd.randint(0, W), rnd.randint(4, 14)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(102, 96, 64))
    img.filter(ImageFilter.GaussianBlur(1.2)).save(os.path.join(ASSETS, "meadow.png"))

    # forest canopy for the hills, seen from far away: dark green with crown clumps
    W = 512
    img = Image.new("RGB", (W, W), (46, 62, 38))
    d = ImageDraw.Draw(img)
    for _ in range(5000):
        x, y, r = rnd.randint(0, W), rnd.randint(0, W), rnd.randint(3, 9)
        g = rnd.uniform(-1, 1)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(int(58 + 18 * g), int(80 + 24 * g), int(44 + 12 * g)))
    img.filter(ImageFilter.GaussianBlur(1.0)).save(os.path.join(ASSETS, "forest.png"))

    # smoke puff (greyscale, read as luminance)
    W = 128
    yy, xx = np.mgrid[0:W, 0:W]
    r = np.hypot(xx - W / 2, yy - W / 2) / (W / 2)
    n = np.random.default_rng(5).normal(0, 1, (W // 8, W // 8))
    n = np.asarray(Image.fromarray(((n - n.min()) / (n.max() - n.min()) * 255).astype("uint8")).resize((W, W), Image.BICUBIC)) / 255.0
    a = np.clip(1 - r, 0, 1) ** 1.8 * (0.55 + 0.45 * n)
    Image.fromarray((a * 255).astype("uint8"), "L").convert("RGB").save(os.path.join(ASSETS, "smoke.png"))

    # painted bracket members: blue-green with a gold border on every face
    img = Image.new("RGB", (64, 64), (46, 92, 84))
    d = ImageDraw.Draw(img)
    d.rectangle([6, 6, 57, 57], fill=(40, 70, 100))
    d.rectangle([12, 12, 51, 51], fill=(52, 104, 92))
    d.rectangle([0, 0, 63, 63], outline=(196, 158, 80), width=4)
    img.save(os.path.join(ASSETS, "bracket_paint.png"))

    # plaque
    img = Image.new("RGB", (768, 320), (60, 40, 26))
    d = ImageDraw.Draw(img)
    d.rectangle([18, 18, 750, 302], fill=(200, 158, 66))
    d.rectangle([34, 34, 734, 286], outline=(150, 108, 40), width=5)
    font = None
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            font = ImageFont.truetype(path, 170)
            break
    text = "大雄宝殿"
    if font:
        for i, ch in enumerate(text):
            cx = 120 + i * 176
            d.text((cx, 160), ch, font=font, fill=(34, 32, 30), anchor="mm")
    img.save(os.path.join(ASSETS, "plaque.png"))


# ---------------------------------------------------------------- components
TILE = material("#ffffff", 0.78, "tileTex")
SOFFIT = material("#ffffff", 0.9, "rafterTex")
FASCIA = material("#5a3424", 0.8)
RIDGE = material("#6a645d", 0.8)
WOOD = "#7a4c30"
COLUMN = "#6a3624"
STONE = "#bdb8ae"
BALUSTRADE = "#dcd8cf"


def roof_block(prefix, roof, rotate=False, ridge_scale=1.0, tile=None):
    """Meshes and ridges for one roof tier; returns SSDL lines."""
    top, under, fascia = roof["top"], roof["under"], roof["fascia"]
    hips = roof["hips"]
    verges = roof["verges"]
    if rotate:
        top, under, fascia = rot90(top), rot90(under), rot90(fascia)
        hips = [rot90_pts(h) for h in hips]
        verges = [rot90_pts(v) for v in verges]
    out = [top.ssdl(f"{prefix}Tiles", tile or TILE, shading="smooth"),
           under.ssdl(f"{prefix}Soffit", SOFFIT, shading="smooth"),
           fascia.ssdl(f"{prefix}Fascia", FASCIA, uvs=False)]
    for i, h in enumerate(hips):
        if len(h) < 3 or length(sub(h[0], h[-1])) < 0.5:
            continue
        out.append(sweep(f"{prefix}Hip{i}", hip_ridge_path(h, 0.9 * ridge_scale, 0.55 * ridge_scale), RIDGE,
                         scaled_profile(ridge_scale)))
    for i, v in enumerate(verges):
        path = [(p[0], p[1], p[2] + 0.1) for p in v]
        out.append(sweep(f"{prefix}Verge{i}", path, RIDGE, scaled_profile(ridge_scale)))
    return out


def _solve_s(f, target):
    lo, hi = -1.0, 1.0
    for _ in range(40):
        m = (lo + hi) / 2
        if f(m) < target:
            lo = m
        else:
            hi = m
    return (lo + hi) / 2


def roof_sides(roof):
    """(ds, P(d, s), axis, xmax(d), outward, yaw) for each slope; x/y along the eave is monotonic in s."""
    A, B, dg, curve = roof["A"], roof["B"], roof["dg"], roof["curve"]
    out = []
    for side, yaw in ((-1, 0), (1, 180)):
        out.append((roof["long_ds"], lambda d, s_, side=side: roof["pt_long"](d, s_, side), 0,
                    lambda d: A - min(d, dg) + curve(d)[1], (0, side, 0), yaw))
    if roof["end_ds"]:
        for side, yaw in ((1, 90), (-1, 270)):
            out.append((roof["end_ds"], lambda d, s_, side=side: roof["pt_end"](d, s_, side), 1,
                        lambda d: B - d + curve(d)[1], (side, 0, 0), yaw))
    return out


def roll_segments(roof, spacing=1 / 3, sink=0.035):
    """Cover-tile rolls (筒瓦) as chained cylinder segments: (position, [rx, ry, rz], length) per segment.

    Rolls are straight lines of constant x (constant y on the hip ends) that follow the curved slope
    from the eave up to where they meet the hip or the ridge. The source cylinder stands along +z,
    so a segment is pitched by (slope - 90) about x and then yawed to its slope."""
    segs = []
    for ds, P, axis, xmax, outv, yaw in roof_sides(roof):
        n = int((xmax(0) - 0.15) / spacing)
        for k in range(-n, n + 1):
            xk = k * spacing
            pts = []
            for i, d in enumerate(ds):
                if abs(xk) > xmax(d) - 0.12:
                    if i > 0:
                        lo, hi = ds[i - 1], d
                        for _ in range(30):
                            m = (lo + hi) / 2
                            if abs(xk) > xmax(m) - 0.12:
                                hi = m
                            else:
                                lo = m
                        pts.append(P(lo, _solve_s(lambda s_: P(lo, s_)[axis], xk)))
                    break
                pts.append(P(d, _solve_s(lambda s_, d=d: P(d, s_)[axis], xk)))
            for a_, b_ in zip(pts, pts[1:]):
                dv = sub(b_, a_)
                L = length(dv)
                if L < 0.08:
                    continue
                h = math.hypot(dv[0], dv[1])
                slope = math.degrees(math.atan2(dv[2], h))
                c = mul(add(a_, b_), 0.5)
                segs.append(((c[0], c[1], c[2] - sink), (slope - 90, 0, yaw), L + 0.04))
    return segs


def eave_rafters(roof, spacing=0.32, inset=0.55):
    """Rafter positions and rotations under the eave: ([x,y,z], [rx,ry,rz]) per rafter."""
    pos, rot = [], []
    th = roof["thick"]
    for ds, P, axis, xmax, outv, yaw in roof_sides(roof):
        n = int((xmax(0) - 0.4) / spacing)
        for k in range(-n, n + 1):
            xk = k * spacing
            s0 = _solve_s(lambda s_: P(0, s_)[axis], xk)
            a, b = P(0, s0), P(ds[1], _solve_s(lambda s_: P(ds[1], s_)[axis], xk))
            dz = b[2] - a[2]
            dh = math.hypot(b[0] - a[0], b[1] - a[1])
            slope = math.degrees(math.atan2(dz, dh))
            c = add(a, mul(outv, -inset))
            c = (c[0], c[1], a[2] + math.tan(math.radians(slope)) * inset - th - 0.05)
            pos.append(c)
            rot.append((slope, 0, yaw))
    return pos, rot


BEAST = [(-0.2, 0), (0.17, 0), (0.17, 0.08), (0.1, 0.13), (0.15, 0.3), (0.24, 0.33), (0.25, 0.42),
         (0.14, 0.47), (0.05, 0.42), (0.0, 0.32), (-0.1, 0.27), (-0.18, 0.36), (-0.23, 0.22), (-0.17, 0.1)]


def hip_beasts(hips, n, first=0.9, step=0.52, z_up=0.34):
    """Ridge beasts (走兽) standing on each hip ridge near the eave: positions and yaws."""
    pos, yaw = [], []
    for h in hips:
        if len(h) < 3 or length(sub(h[0], h[-1])) < 0.5:
            continue
        cum = [0.0]
        for a, b in zip(h, h[1:]):
            cum.append(cum[-1] + length(sub(b, a)))
        for k in range(n):
            t = first + k * step
            for i in range(len(h) - 1):
                if cum[i + 1] >= t:
                    f = (t - cum[i]) / (cum[i + 1] - cum[i])
                    p_ = add(h[i], mul(sub(h[i + 1], h[i]), f))
                    o = sub(h[i], h[i + 1])
                    pos.append((p_[0], p_[1], p_[2] + 0.1 + z_up))
                    yaw.append(math.degrees(math.atan2(o[1], o[0])))
                    break
    return pos, yaw


def corner_bells(mb, roof, drop=0.55):
    """A bronze wind bell (风铎) hanging under each of the four eave corners."""
    for sx in (-1, 1):
        for sy in (-1, 1):
            c = roof["pt_long"](0, 1.0, 1)
            c = (sx * c[0], sy * c[1], c[2] - roof["thick"])
            top = (c[0] - sx * 0.25, c[1] - sy * 0.25, c[2])
            mb.bar(top, (top[0], top[1], top[2] - drop), 0.03, 0.03, up=(1, 0, 0))
            z = top[2] - drop
            mb.lathe([(0.01, -0.34), (0.15, -0.34), (0.13, -0.24), (0.1, -0.08), (0.06, -0.01), (0.01, 0.0)],
                     (top[0], top[1], z), 10)
            mb.lathe([(0.01, -0.5), (0.05, -0.5), (0.05, -0.36), (0.01, -0.36)], (top[0], top[1], z), 6)


RIDGE_PROFILE = [[-0.36, 0, 0], [0.36, 0, 0], [0.36, 0, 0.12], [0.28, 0, 0.17], [0.28, 0, 0.9], [0.34, 0, 0.96],
                 [0.34, 0, 1.1], [0.24, 0, 1.2], [-0.24, 0, 1.2], [-0.34, 0, 1.1], [-0.34, 0, 0.96],
                 [-0.28, 0, 0.9], [-0.28, 0, 0.17], [-0.36, 0, 0.12]]


def hall_roofs():
    zl = LOW_EAVE_Z - TERRACE_Z
    A1, B1 = BODY_HX + 3.3, BODY_HY + 3.3
    d1 = A1 - (UP_HX - 0.2)
    lower = curved_roof(A1, B1, zl, (UP_WALL_Z0 + 0.1) - LOW_EAVE_Z, d1, lift=0.75, flare=0.55,
                        decay=d1, nd=10, ns=48, p=(0.7, 0.3), ridge=False, thick=0.3)
    zu = UP_EAVE_Z - TERRACE_Z
    A2, B2 = UP_HX + 2.9, UP_HY + 2.9
    upper = curved_roof(A2, B2, zu, UP_ROOF_H, B2, lift=0.95, flare=0.7, decay=B2 * 0.7, nd=18, ns=48)
    return lower, upper


def gen_hall_rolls():
    """Cover-tile rolls of both hall roofs: one cylinder source, 512-row instance batches."""
    lower, upper = hall_roofs()
    segs = roll_segments(lower) + roll_segments(upper)
    L = ["// Generated by gen_scene.py: the cover-tile rolls (筒瓦) of the hall's two roofs, same frame as HallRoof.",
         f"// {len(segs)} segments of one cylinder; the flat end at the eave reads as the tile-end disc (瓦当).",
         "Group {", "  id: root",
         f"  Cylinder {{ id: rollSrc; radius: 0.085; height: 1; segments: 10; position: [0, 0, -30]; visible: false; "
         f"{material('#6e6963', 0.7)} }}"]
    per_prefab = 2048
    for pi in range(0, len(segs), per_prefab):
        L.append(f"  Prefab {{ id: rollPf{pi // per_prefab}; source: rollSrc }}")
    for bi in range(0, len(segs), 512):
        chunk = segs[bi:bi + 512]

        def n2(v): return f"{v:.2f}".rstrip("0").rstrip(".") if abs(v) >= 0.005 else "0"
        pos = "[" + ",".join("[" + ",".join(n2(c) for c in p_) + "]" for p_, _, _ in chunk) + "]"
        rot = "[" + ",".join("[" + ",".join(f"{c:.1f}".rstrip("0").rstrip(".") for c in r_) + "]" for _, r_, _ in chunk) + "]"
        sc = "[" + ",".join(f"[1,1,{l_:.2f}]" for _, _, l_ in chunk) + "]"
        L.append(f"  Instances {{ id: rolls{bi // 512}; prefab: rollPf{bi // per_prefab}; positions: {pos}; "
                 f"rotations: {rot}; scales: {sc} }}")
    L.append("}")
    return "\n".join(L) + "\n"


def gen_hall_roof():
    lines = ["// Generated by gen_scene.py: double-eave hip roof (重檐庑殿) of the main hall.",
             "// Local frame = hall centre on the terrace. Skirt + upper hip roof, modelled cover-tile rolls,",
             "// rafters, ridge beasts, corner bells, moulded main ridge with relief, chiwen and finial.",
             "Group {", "  id: root",
             '  Texture { id: panTex; source: "assets/pantiles.png" }',
             '  Texture { id: rafterTex; source: "assets/rafters.png" }',
             '  Texture { id: reliefTex; source: "assets/rail_panel.png" }']
    pan = material("#ffffff", 0.8, "panTex")
    lower, upper = hall_roofs()
    zl = LOW_EAVE_Z - TERRACE_Z
    A1, B1 = BODY_HX + 3.3, BODY_HY + 3.3
    d1 = A1 - (UP_HX - 0.2)
    lines += ["  " + s_ for s_ in roof_block("lower", lower, tile=pan)]
    zt = lower["zf"](d1)
    a, b = A1 - d1, B1 - d1
    lines.append("  " + box("lowerBandS", (2 * a + 0.5, 0.5, 0.45), (0, -b, zt + 0.1), RIDGE))
    lines.append("  " + box("lowerBandN", (2 * a + 0.5, 0.5, 0.45), (0, b, zt + 0.1), RIDGE))
    lines.append("  " + box("lowerBandE", (0.5, 2 * b + 0.5, 0.45), (a, 0, zt + 0.1), RIDGE))
    lines.append("  " + box("lowerBandW", (0.5, 2 * b + 0.5, 0.45), (-a, 0, zt + 0.1), RIDGE))

    zu = UP_EAVE_Z - TERRACE_Z
    lines += ["  " + s_ for s_ in roof_block("upper", upper, tile=pan)]

    # rafters (飞椽) under both eaves: one Box prefab, two instance batches
    lines.append(f"  Box {{ id: rafterSrc; width: 0.11; depth: 1.1; height: 0.11; position: [0, 0, -30]; visible: false; "
                 f"{material('#6a3a24', 0.8)} }}")
    lines.append("  Prefab { id: rafterPf; source: rafterSrc }")
    for nm, roof in (("lowerRafters", lower), ("upperRafters", upper)):
        pos, rot = eave_rafters(roof)
        lines.append(f"  Instances {{ id: {nm}; prefab: rafterPf; positions: {vlist(pos)}; rotations: {vlist(rot)} }}")

    # ridge beasts: one silhouette prefab, placed on every hip of both roofs
    bm = MeshBuilder()
    bm.prism(BEAST, (0, 0, 0), (1, 0, 0), (0, 0, 1), (0, 1, 0), 0.16)
    lines.append("  " + bm.ssdl("beastSrc", material("#57524c", 0.7), uvs=False, visible=False, extra="position: [0, 0, -30]"))
    lines.append("  Prefab { id: beastPf; source: beastSrc }")
    bp, by = hip_beasts(upper["hips"], 5)
    lp, ly = hip_beasts(lower["hips"], 3, first=0.8)
    lines.append(f"  Instances {{ id: ridgeBeasts; prefab: beastPf; positions: {vlist(bp + lp)}; "
                 f"rotations_z: {slist(by + ly)} }}")

    bells = MeshBuilder()
    corner_bells(bells, upper)
    corner_bells(bells, lower)
    lines.append("  " + bells.ssdl("windBells", material("#4b5a4a", 0.45, metal=0.7), shading="smooth", uvs=False))

    # main ridge: moulded section with carved relief panels, chiwen at both ends, finial in the middle
    rz = upper["ridge_z"]
    rh = upper["ridge_half"]
    lines.append(f"  Sweep {{ id: mainRidge; profile: {vlist(RIDGE_PROFILE)}; path: {vlist([(-rh - 0.3, 0, rz - 0.2), (rh + 0.3, 0, rz - 0.2)])}; "
                 f"cap: true; flat: true; {RIDGE} }}")
    rel = MeshBuilder()
    for sy in (-1, 1):
        y = sy * 0.29
        n = max(1, int(round(2 * rh / 2.0)))
        rel.rect((-rh, y, rz + 0.05), (rh, y, rz + 0.05), (rh, y, rz + 0.62), (-rh, y, rz + 0.62), (0, sy, 0),
                 ((0, 0), (n, 0), (n, 1), (0, 1)))
    lines.append("  " + rel.ssdl("ridgeRelief", material("#8a847c", 0.8, "reliefTex")))
    orn = MeshBuilder()
    chiwen(orn, rh + 0.25, rz + 1.0, 1)
    chiwen(orn, -(rh + 0.25), rz + 1.0, -1)
    lines.append("  " + orn.ssdl("chiwen", material("#4a4642", 0.7), uvs=False))
    fin = MeshBuilder()
    fin.lathe([(0.45, 0), (0.5, 0.12), (0.3, 0.26), (0.5, 0.62), (0.36, 0.95), (0.14, 1.06), (0.24, 1.3),
               (0.14, 1.55), (0.05, 1.72), (0.005, 1.8)], (0, 0, rz + 1.0), 16)
    lines.append("  " + fin.ssdl("ridgeFinial", material("#a8843c", 0.35, metal=0.8), shading="smooth", uvs=False))
    lines.append("}")
    return "\n".join(lines) + "\n"


def facade_quad(mb, x0, x1, y, z0, z1, u_rep=1.0, v_rep=1.0):
    # measured on this engine: v = 0 is the image's bottom row, u = 0 its left column
    mb.rect((x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1), (0, -1, 0),
            ((0, 0), (u_rep, 0), (u_rep, v_rep), (0, v_rep)))


def seated_buddha(mb, c, k=1.0):
    """A seated gilt Buddha on a lotus throne, about 5.2 m x k, built from revolved sections."""
    x0, y0, z0 = c

    def L(prof, cz, sy=1.0, segs=20, dx=0.0, dy=0.0):
        m = MeshBuilder()
        m.lathe([(r * k, h * k) for r, h in prof], (0, 0, 0), segs)
        mb.extend(m.transformed(lambda p: (x0 + dx * k + p[0], y0 + dy * k + p[1] * sy, z0 + cz * k + p[2])))
    # lotus throne: octagonal plinth, waisted drum, a ring of petals
    L([(1.5, 0), (1.55, 0.25), (1.2, 0.3), (1.0, 0.55), (1.15, 0.6), (1.45, 0.72), (1.6, 0.95), (1.62, 1.1),
       (1.2, 1.12), (0.01, 1.14)], 0, 0.8, 8)
    for i in range(16):
        a = 2 * math.pi * i / 16
        m = MeshBuilder()
        m.lathe([(0.01, 0), (0.22, 0.12), (0.26, 0.35), (0.14, 0.55), (0.01, 0.62)], (0, 0, 0), 6)
        px, py = 1.45 * math.cos(a) * k, 1.45 * math.sin(a) * 0.8 * k
        mb.extend(m.transformed(lambda p, px=px, py=py: (x0 + px + p[0] * k, y0 + py + p[1] * 0.5 * k, z0 + 0.62 * k + p[2] * k)))
    # crossed legs, torso, shoulders, neck, head, ushnisha
    L([(0.01, 0), (1.25, 0.02), (1.3, 0.25), (1.05, 0.52), (0.5, 0.6), (0.01, 0.62)], 1.12, 0.62)
    L([(0.72, 0), (0.78, 0.4), (0.74, 0.9), (0.78, 1.2), (0.62, 1.45), (0.3, 1.55), (0.18, 1.6), (0.01, 1.62)],
      1.6, 0.62, dy=0.1)
    L([(0.01, 0), (0.28, 0.02), (0.36, 0.2), (0.38, 0.45), (0.33, 0.66), (0.22, 0.8), (0.24, 0.9), (0.14, 1.02),
       (0.01, 1.05)], 3.15, 0.95, dy=0.1)
    # hands resting in the lap
    L([(0.01, 0), (0.3, 0.02), (0.32, 0.12), (0.01, 0.16)], 1.62, 0.6, dy=-0.55)
    # flaming halo behind: a flat disc revolved about y
    m = MeshBuilder()
    m.lathe([(0.01, 0), (1.35, 0.0), (1.45, 0.06), (1.35, 0.12), (0.01, 0.12)], (0, 0, 0), 28, axis="y")
    mb.extend(m.transformed(lambda p: (x0 + p[0] * k, y0 + 0.75 * k + p[1] * k, z0 + 3.4 * k + p[2] * k)))


LANTERN_PROF = [(0.2, -0.42), (0.36, -0.34), (0.44, -0.16), (0.46, 0.0), (0.44, 0.16), (0.36, 0.34), (0.2, 0.42)]
NIGHT = "main.timeOfDay < 6.4 || main.timeOfDay > 17.4"


def hall_lantern_spots():
    """Lantern centres in the hall frame: under the lower eave, in front of bays 1, 2, 4 and 5."""
    ct = COL_TOP - TERRACE_Z
    xs = [-BODY_HX]
    for w_ in BAYS:
        xs.append(xs[-1] + w_)
    return [((xs[i] + xs[i + 1]) / 2, -BODY_HY - 0.9, ct - 2.0) for i in (1, 2, 4, 5)]


def night_lamps():
    """Scene-frame nodes that switch on with the night: lantern glow shells and warm point lights."""
    T = TERRACE_Z
    glow = MeshBuilder()
    out = []
    win = lantern_windows(STONE_LANTERN_SPOTS, T)
    win.extend(lantern_windows(PLAZA_LANTERN_SPOTS, 0))
    out.append("  " + win.ssdl("stoneLanternGlow", material("#ffb060", 0.6, extra="emissiveColor: [3, 1.4, 0.45]"),
                               uvs=False, extra=f"visible: {NIGHT}"))
    for i, (x, y) in enumerate(STONE_LANTERN_SPOTS[:2]):
        out.append(f"  PointLight {{ id: stoneLanternLight{i}; position: {vec((x, y, T + 2.2))}; intensity: {NIGHT} ? 2000 : 0; "
                   f'attenuationRadius: 10; lightColor: "#ffb070"; castShadows: false }}')
    for i, (cx, cy, zc_) in enumerate(hall_lantern_spots()):
        glow.lathe([(r * 1.015, h) for r, h in LANTERN_PROF], (cx, cy + HALL_Y, zc_ + T), 16)
        if i in (1, 2):
            out.append(f"  PointLight {{ id: lanternLight{i}; position: {vec((cx, cy + HALL_Y - 1.5, zc_ + T - 0.4))}; "
                       f'intensity: {NIGHT} ? 8000 : 0; attenuationRadius: 14; lightColor: "#ff9a5a"; castShadows: false }}')
    out.insert(0, "  " + glow.ssdl("lanternGlow", material("#ff5a2a", 0.6, extra="emissiveColor: [4, 0.9, 0.28]"),
                                   shading="smooth", uvs=False, extra=f"visible: {NIGHT}"))
    # incense smoke: the particles are unlit, so after dark a darker copy keeps them from glowing white
    DIM = NIGHT
    for nm, vis, c0, c1, a0 in (("incense", f"!({DIM})", "#e8e2d8", "#c8ccd2", 0.32),
                                ("incenseNight", DIM, "#4a4640", "#3a3c40", 0.22)):
        out.append(f'  ParticleEmitter {{ id: {nm}; visible: {vis}; position: [0, 7.5, {num(T + 2.0)}]; sprite: smokeTex; '
                   f'opacitySource: "luminance"; blend: "alpha"; rate: 9; maxParticles: 200; lifetime: [6, 9]; speed: [0.25, 0.5]; '
                   f'direction: [0, 0, 1]; spread: 14; gravity: -0.06; drag: 0.15; size: [0.35, 3.2]; sizeVariation: 0.3; '
                   f'colorStart: "{c0}"; colorEnd: "{c1}"; alphaStart: {a0}; alphaEnd: 0; rotationSpeed: [-12, 12]; warmup: 8; '
                   f'shape: "sphere"; shapeSize: [0.15, 0.15, 0.15] }}')
    return out


def gen_main_hall():
    """Local frame: hall centre on the terrace (z = 0 is the terrace top)."""
    pz = PLATFORM_Z - TERRACE_Z
    ct = COL_TOP - TERRACE_Z
    L = ["// Generated by gen_scene.py: the main hall below the roofs. Stone Sumeru base, column bases,",
         "// tapered columns, frames and sill walls, painted beams, braces, bracket sets, an open centre bay",
         "// with the seated Buddha inside, the upper storey, the plaque and hanging lanterns.",
         "Group {", "  id: root",
         '  Texture { id: doorTex; source: "assets/door_bay.png" }',
         '  Texture { id: windowTex; source: "assets/window_bay.png" }',
         '  Texture { id: brickTex; source: "assets/brick.png" }',
         '  Texture { id: latticeTex; source: "assets/lattice_strip.png" }',
         '  Texture { id: plaqueTex; source: "assets/plaque.png" }',
         '  Texture { id: beamTex; source: "assets/beam_paint.png" }',
         '  Texture { id: bracketTex; source: "assets/bracket_paint.png" }',
         '  Texture { id: stoneTex; source: "assets/stone.png" }']
    lacquer = material("#7a2a1c", 0.55)
    stone = material("#ffffff", 0.88, "stoneTex")
    # --- Sumeru base (须弥座): stacked mouldings around a recessed waist
    W, D = 34.0, 25.0
    for nm, z0, z1, g in (("plinth", 0, 0.12, 0.4), ("lowerFascia", 0.12, 0.26, 0.2), ("lowerCyma", 0.26, 0.34, -0.1),
                          ("waist", 0.34, 0.64, -0.4), ("upperCyma", 0.64, 0.74, -0.1), ("upperFascia", 0.74, 0.92, 0.2),
                          ("lip", 0.92, pz, 0.4)):
        L.append("  " + box(f"base_{nm}", (W + g, D + g, z1 - z0), (0, 0, (z0 + z1) / 2), stone))
    posts = MeshBuilder()
    for i in range(22):
        x = -W / 2 + 0.6 + i * (W - 1.2) / 21
        if abs(x) < 8.4:
            continue
        posts.box((x, -D / 2 + 0.17, 0.49), (0.16, 0.08, 0.3))
    for j in range(16):
        y = -D / 2 + 0.6 + j * (D - 1.2) / 15
        for sx in (-1, 1):
            posts.box((sx * (W / 2 - 0.17), y, 0.49), (0.08, 0.16, 0.3))
    L.append("  " + posts.ssdl("waistPosts", stone))
    L.append(f"  Stairs {{ id: hallSteps; steps: 6; rise: {num(pz / 6)}; run: 0.35; width: 16; "
             f"position: [0, {num(-12.7 - 2.1)}, 0]; rotation: {vec(qz(90))}; {material('#c9c3b8', 0.9)} }}")
    cheek = MeshBuilder()
    for sx in (-1, 1):
        poly = [(-12.7 - 2.25, 0), (-12.5, 0), (-12.5, pz + 0.02), (-12.7 - 2.25, 0.14)]
        cheek.prism(poly, (sx * 8.25, 0, 0), (0, 1, 0), (0, 0, 1), (1, 0, 0), 0.5)
    L.append("  " + cheek.ssdl("hallStepCheeks", stone))

    # --- interior shell: the centre bay is open, so the core is a room, not a block
    ih = ct + 1.2 - pz
    iy0, iy1 = -BODY_HY + 0.62, BODY_HY - 0.6
    ix = BODY_HX - 0.3
    wall = material("#4a2c1e", 0.9)
    L.append("  " + box("coreBack", (2 * ix, 0.3, ih), (0, iy1, pz + ih / 2), wall))
    L.append("  " + box("coreWest", (0.3, iy1 - iy0, ih), (-ix, (iy0 + iy1) / 2, pz + ih / 2), wall))
    L.append("  " + box("coreEast", (0.3, iy1 - iy0, ih), (ix, (iy0 + iy1) / 2, pz + ih / 2), wall))
    L.append("  " + box("coreCeiling", (2 * ix, iy1 - iy0, 0.3), (0, (iy0 + iy1) / 2, pz + ih), material("#3a2418", 0.9)))
    L.append("  " + box("coreFloor", (2 * ix, iy1 - iy0, 0.04), (0, (iy0 + iy1) / 2, pz + 0.02), material("#5e5750", 0.6)))
    L.append("  " + box("coreFront", (2 * ix, 0.2, ih), (0, iy0 + 0.1, pz + ih / 2), wall, visible=False))

    fy = -BODY_HY + 0.58
    xs = [-BODY_HX]
    for w_ in BAYS:
        xs.append(xs[-1] + w_)
    doors, windows, bricks, transom, frames, sill = (MeshBuilder() for _ in range(6))
    z_door_top = pz + 3.9
    z_top = ct - 0.55
    for i in range(7):
        x0, x1 = xs[i] + 0.3, xs[i + 1] - 0.3
        if i in (0, 6):
            facade_quad(bricks, x0, x1, fy, pz, z_top, u_rep=(x1 - x0), v_rep=(z_top - pz))
            continue
        # frame: 抱框 posts, 下槛 threshold, 中槛, 上槛
        for x in (x0 + 0.09, x1 - 0.09):
            frames.box((x, fy - 0.06, (pz + z_top) / 2), (0.18, 0.2, z_top - pz))
        frames.box(((x0 + x1) / 2, fy - 0.06, pz + 0.15), (x1 - x0, 0.22, 0.3))
        frames.box(((x0 + x1) / 2, fy - 0.07, z_door_top + 0.1), (x1 - x0, 0.22, 0.2))
        frames.box(((x0 + x1) / 2, fy - 0.07, z_top - 0.1), (x1 - x0, 0.22, 0.2))
        facade_quad(transom, x0 + 0.18, x1 - 0.18, fy, z_door_top + 0.2, z_top - 0.2, u_rep=(x1 - x0) / 3)
        if i in (1, 5):
            # 槛窗 over a brick sill wall with a stone sill board
            sill.box(((x0 + x1) / 2, fy + 0.05, pz + 0.5), (x1 - x0 - 0.36, 0.5, 1.0))
            frames.box(((x0 + x1) / 2, fy - 0.08, pz + 1.04), (x1 - x0 - 0.3, 0.6, 0.08))
            facade_quad(windows, x0 + 0.18, x1 - 0.18, fy, pz + 1.08, z_door_top)
        elif i == 3:
            # open centre bay: outer leaves shut, middle leaves swung in against the reveal
            lw = (x1 - x0 - 0.36) / 4
            xa, xb = x0 + 0.18, x1 - 0.18
            doors.rect((xa, fy, pz + 0.3), (xa + lw, fy, pz + 0.3), (xa + lw, fy, z_door_top), (xa, fy, z_door_top),
                       (0, -1, 0), ((0, 0), (0.25, 0), (0.25, 1), (0, 1)))
            doors.rect((xb - lw, fy, pz + 0.3), (xb, fy, pz + 0.3), (xb, fy, z_door_top), (xb - lw, fy, z_door_top),
                       (0, -1, 0), ((0.75, 0), (1, 0), (1, 1), (0.75, 1)))
            for sx, xh in ((-1, xa + lw), (1, xb - lw)):
                ang = math.radians(78)
                ex = xh - sx * lw * math.cos(ang)
                ey = fy + lw * math.sin(ang)
                for face in (-1, 1):
                    pts = [(xh, fy, pz + 0.3), (ex, ey, pz + 0.3), (ex, ey, z_door_top), (xh, fy, z_door_top)]
                    nrm = (-sx * math.sin(ang) * face, -math.cos(ang) * face, 0)
                    doors.rect(*pts, nrm, ((0.25, 0), (0.5, 0), (0.5, 1), (0.25, 1)))
        else:
            facade_quad(doors, x0 + 0.18, x1 - 0.18, fy, pz + 0.3, z_door_top)
    L.append("  " + doors.ssdl("frontDoors", material("#ffffff", 0.7, "doorTex")))
    L.append("  " + windows.ssdl("frontWindows", material("#ffffff", 0.7, "windowTex")))
    L.append("  " + bricks.ssdl("cornerBrick", material("#ffffff", 0.95, "brickTex")))
    L.append("  " + transom.ssdl("frontTransom", material("#ffffff", 0.7, "latticeTex")))
    L.append("  " + frames.ssdl("doorFrames", lacquer))
    L.append("  " + sill.ssdl("sillWalls", material("#ffffff", 0.95, "brickTex")))
    # front wall pieces either side of the open bay close the room
    for nm, xa, xb in (("W", -ix, xs[3] + 0.3), ("E", xs[4] - 0.3, ix)):
        L.append("  " + box(f"frontWall{nm}", (xb - xa, 0.2, ih), ((xa + xb) / 2, fy + 0.14, pz + ih / 2), wall))

    # --- the Buddha, altar, candles and a warm light inside
    bud = MeshBuilder()
    seated_buddha(bud, (0, 3.2, pz), 1.0)
    L.append("  " + bud.ssdl("buddha", material("#c89a3a", 0.32, metal=0.85), shading="smooth", uvs=False))
    L.append("  " + box("altar", (3.6, 1.1, 1.0), (0, 0.4, pz + 0.5), material("#6a1c14", 0.6)))
    L.append("  " + box("altarCloth", (3.7, 0.04, 0.8), (0, -0.16, pz + 0.55), material("#b8862e", 0.5)))
    for sx in (-1, 1):
        L.append(f"  Cylinder {{ id: candle{'WE'[sx > 0]}; radius: 0.07; height: 0.5; segments: 10; "
                 f"position: [{num(sx * 1.2)}, 0.4, {num(pz + 1.25)}]; {material('#c23a28', 0.5)} }}")
        L.append(f"  Sphere {{ id: flame{'WE'[sx > 0]}; radius: 0.06; segments: 8; scale: [1, 1, 1.8]; "
                 f"position: [{num(sx * 1.2)}, 0.4, {num(pz + 1.58)}]; {material('#ffb050', 0.5, extra='emissiveColor: [9, 5, 1.6]')} }}")
    L.append(f"  PointLight {{ id: altarLight; position: [0, -1.2, {num(pz + 2.6)}]; intensity: 900; attenuationRadius: 14; "
             f'lightColor: "#ffb870"; castShadows: false }}')

    # --- beams: 小额枋, 垫板, 大额枋 with painted faces, 平板枋 on top
    L.append("  " + box("frontBeam", (2 * BODY_HX + 0.8, 0.5, 0.55), (0, -BODY_HY, ct - 0.28), lacquer))
    L.append("  " + box("frontBeamLow", (2 * BODY_HX + 0.4, 0.4, 0.34), (0, -BODY_HY + 0.03, ct - 0.8), lacquer))
    L.append("  " + box("beamBoard", (2 * BODY_HX + 0.4, 0.3, 0.12), (0, -BODY_HY + 0.05, ct - 0.6), material("#8e3322", 0.6)))
    L.append("  " + box("sideBeams", (2 * BODY_HX + 0.8, 2 * BODY_HY + 0.8, 0.5), (0, 0, ct - 0.26), lacquer))
    L.append("  " + box("capBeam", (2 * BODY_HX + 1.0, 2 * BODY_HY + 1.0, 0.14), (0, 0, ct + 0.06), material("#5a2418", 0.6)))
    paint = MeshBuilder()
    for i in range(7):
        xa, xb = xs[i] + 0.3, xs[i + 1] - 0.3
        paint.rect((xa, -BODY_HY - 0.252, ct - 0.54), (xb, -BODY_HY - 0.252, ct - 0.54), (xb, -BODY_HY - 0.252, ct - 0.02),
                   (xa, -BODY_HY - 0.252, ct - 0.02), (0, -1, 0))
        paint.rect((xa, -BODY_HY - 0.172, ct - 0.96), (xb, -BODY_HY - 0.172, ct - 0.96), (xb, -BODY_HY - 0.172, ct - 0.64),
                   (xa, -BODY_HY - 0.172, ct - 0.64), (0, -1, 0))
    ys_side = [-BODY_HY, -5.0, 0.0, 5.0, BODY_HY]
    for sx in (-1, 1):
        for ya, yb in zip(ys_side, ys_side[1:]):
            ya2, yb2 = ya + 0.3, yb - 0.3
            x = sx * (BODY_HX + 0.402)
            p0, p1 = ((x, ya2), (x, yb2)) if sx > 0 else ((x, yb2), (x, ya2))
            paint.rect((p0[0], p0[1], ct - 0.5), (p1[0], p1[1], ct - 0.5), (p1[0], p1[1], ct - 0.02),
                       (p0[0], p0[1], ct - 0.02), (sx, 0, 0))
    L.append("  " + paint.ssdl("beamPaint", material("#ffffff", 0.6, "beamTex")))

    # --- 雀替 braces under the low beam either side of every inner front column
    brace = MeshBuilder()
    sil = [(0, 0), (1.15, 0), (1.12, -0.08), (0.95, -0.12), (0.8, -0.1), (0.66, -0.18), (0.5, -0.2), (0.38, -0.3),
           (0.22, -0.34), (0.1, -0.5), (0, -0.56)]
    for x in xs[1:-1]:
        for sx in (-1, 1):
            poly = [(u * sx, v) for u, v in sil]
            brace.prism(poly, (x, -BODY_HY - 0.05, ct - 0.97), (1, 0, 0), (0, 0, 1), (0, 1, 0), 0.16)
    L.append("  " + brace.ssdl("braces", material("#ffffff", 0.6, "bracketTex")))

    # --- columns: tapered, on carved drum bases
    cols = []
    for x in xs:
        cols += [(x, -BODY_HY), (x, BODY_HY)]
    for y in (-5.0, 0.0, 5.0):
        cols += [(-BODY_HX, y), (BODY_HX, y)]
    colh = ct - pz - 0.2
    L.append(f"  Lathe {{ id: columnSrc; profile: {vlist([(0.3, 0, 0), (0.305, 0, 0.6), (0.295, 0, colh * 0.6), (0.275, 0, colh)])}; "
             f"segments: 24; smooth: \"catmullrom\"; samples: 4; position: [0, 0, -30]; visible: false; {material('#8a2c1c', 0.5)} }}")
    L.append("  Prefab { id: columnPf; source: columnSrc }")
    L.append(f"  Instances {{ id: columns; prefab: columnPf; positions: {vlist([(x, y, pz + 0.2) for x, y in cols])} }}")
    bm = MeshBuilder()
    bm.box((0, 0, 0.05), (0.92, 0.92, 0.1))
    bm.lathe([(0.44, 0.1), (0.46, 0.14), (0.44, 0.2), (0.38, 0.24), (0.33, 0.26), (0.01, 0.26)], (0, 0, 0), 20)
    L.append("  " + bm.ssdl("baseSrc", stone, shading="smooth", visible=False, extra="position: [0, 0, -30]"))
    L.append("  Prefab { id: basePf; source: baseSrc }")
    L.append(f"  Instances {{ id: columnBases; prefab: basePf; positions: {vlist([(x, y, pz - 0.06) for x, y in cols])} }}")

    # --- bracket sets (斗拱): three tiers of arms, a slanting 昂, continuous purlins; outward = -y
    br = MeshBuilder()
    br.box((0, 0, 0.1), (0.36, 0.36, 0.2))
    br.bar((0, 0.3, 0.29), (0, -0.48, 0.29), 0.15, 0.18)
    br.box((0, 0, 0.29), (0.95, 0.15, 0.18))
    for x, y in ((-0.44, 0), (0.44, 0), (0, -0.44)):
        br.box((x, y, 0.44), (0.2, 0.2, 0.12))
    br.bar((0, 0.3, 0.56), (0, -0.84, 0.56), 0.15, 0.18)
    br.box((0, 0, 0.56), (1.35, 0.15, 0.18))
    br.box((0, -0.44, 0.56), (0.95, 0.15, 0.18))
    for x, y in ((-0.64, 0), (0.64, 0), (-0.44, -0.44), (0.44, -0.44), (0, -0.82)):
        br.box((x, y, 0.71), (0.2, 0.2, 0.12))
    br.bar((0, 0.25, 0.95), (0, -1.22, 0.56), 0.15, 0.17)
    br.box((0, -0.82, 0.83), (1.05, 0.15, 0.18))
    br.box((0, -1.08, 1.0), (1.2, 0.16, 0.2))
    br.box((0, 0, 0.9), (1.2, 0.16, 0.3))
    br.box((0, -0.5, 1.06), (1.2, 0.14, 0.14))
    L.append("  " + br.ssdl("bracketSrc", material("#ffffff", 0.65, "bracketTex"), visible=False,
                            extra="position: [0, 0, -30]"))
    L.append("  Prefab { id: bracketPf; source: bracketSrc }")

    def ring_path(hx, hy, z):
        return [(-hx, -hy, z), (hx, -hy, z), (hx, hy, z), (-hx, hy, z), (-hx, -hy + 0.01, z)]
    L.append(f"  Instances {{ id: lowerBrackets; prefab: bracketPf; placement: \"along_path\"; "
             f"path: {vlist(ring_path(BODY_HX + 0.1, BODY_HY + 0.1, ct + 0.13))}; step: 1.2; alignToPath: true }}")

    # --- upper storey: short columns, lattice on all four faces, painted beam, brackets
    uz0, uz1 = UP_WALL_Z0 - TERRACE_Z - 0.4, UP_WALL_Z1 - TERRACE_Z
    L.append("  " + box("upperCore", (2 * UP_HX, 2 * UP_HY, uz1 - uz0), (0, 0, (uz0 + uz1) / 2), material("#5a3222", 0.85)))
    up = MeshBuilder()
    facade_quad(up, -UP_HX + 0.3, UP_HX - 0.3, -UP_HY - 0.02, uz0 + 0.4, uz1 - 0.1, u_rep=(2 * UP_HX - 0.6) / 3)
    up.rect((UP_HX - 0.3, UP_HY + 0.02, uz0 + 0.4), (-UP_HX + 0.3, UP_HY + 0.02, uz0 + 0.4),
            (-UP_HX + 0.3, UP_HY + 0.02, uz1 - 0.1), (UP_HX - 0.3, UP_HY + 0.02, uz1 - 0.1), (0, 1, 0),
            ((0, 0), ((2 * UP_HX - 0.6) / 3, 0), ((2 * UP_HX - 0.6) / 3, 1), (0, 1)))
    for sx in (-1, 1):
        x = sx * (UP_HX + 0.02)
        ya, yb = (-UP_HY + 0.3, UP_HY - 0.3) if sx > 0 else (UP_HY - 0.3, -UP_HY + 0.3)
        up.rect((x, ya, uz0 + 0.4), (x, yb, uz0 + 0.4), (x, yb, uz1 - 0.1), (x, ya, uz1 - 0.1), (sx, 0, 0),
                ((0, 0), ((2 * UP_HY - 0.6) / 3, 0), ((2 * UP_HY - 0.6) / 3, 1), (0, 1)))
    L.append("  " + up.ssdl("upperLattice", material("#ffffff", 0.7, "latticeTex")))
    ucols = [(-UP_HX + i * (2 * UP_HX) / 7, -UP_HY - 0.12, (uz0 + uz1) / 2) for i in range(8)]
    ucols += [(-UP_HX + i * (2 * UP_HX) / 7, UP_HY + 0.12, (uz0 + uz1) / 2) for i in range(8)]
    ucols += [(sx * (UP_HX + 0.12), -UP_HY + j * (2 * UP_HY) / 4, (uz0 + uz1) / 2) for sx in (-1, 1) for j in range(1, 4)]
    L.append(f"  Cylinder {{ id: upperColSrc; radius: 0.22; height: {num(uz1 - uz0)}; segments: 16; position: [0, 0, -30]; "
             f"visible: false; {material('#8a2c1c', 0.5)} }}")
    L.append("  Prefab { id: upperColPf; source: upperColSrc }")
    L.append(f"  Instances {{ id: upperColumns; prefab: upperColPf; positions: {vlist(ucols)} }}")
    L.append("  " + box("upperBeam", (2 * UP_HX + 0.6, 2 * UP_HY + 0.6, 0.45), (0, 0, uz1 + 0.05), lacquer))
    upaint = MeshBuilder()
    for i in range(7):
        xa, xb = -UP_HX + i * (2 * UP_HX) / 7 + 0.25, -UP_HX + (i + 1) * (2 * UP_HX) / 7 - 0.25
        upaint.rect((xa, -UP_HY - 0.302, uz1 - 0.15), (xb, -UP_HY - 0.302, uz1 - 0.15), (xb, -UP_HY - 0.302, uz1 + 0.25),
                    (xa, -UP_HY - 0.302, uz1 + 0.25), (0, -1, 0))
    L.append("  " + upaint.ssdl("upperBeamPaint", material("#ffffff", 0.6, "beamTex")))
    L.append("  " + box("upperCapBeam", (2 * UP_HX + 0.8, 2 * UP_HY + 0.8, 0.12), (0, 0, uz1 + 0.33), material("#5a2418", 0.6)))
    L.append(f"  Instances {{ id: upperBrackets; prefab: bracketPf; placement: \"along_path\"; "
             f"path: {vlist(ring_path(UP_HX + 0.2, UP_HY + 0.2, uz1 + 0.39))}; step: 1.1; alignToPath: true }}")

    # --- plaque with a carved gilt frame
    pl = MeshBuilder()
    py = -UP_HY - 1.05
    pl.rect((-1.9, py, uz1 - 0.95), (1.9, py, uz1 - 0.95), (1.9, py, uz1 + 0.6),
            (-1.9, py, uz1 + 0.6), (0, -1, 0), ((0, 0), (1, 0), (1, 1), (0, 1)))
    L.append("  " + pl.ssdl("plaque", material("#ffffff", 0.5, "plaqueTex")))
    fr = MeshBuilder()
    zc = uz1 - 0.175
    for (cx, cz, sw, sh) in ((0, uz1 + 0.68, 4.3, 0.2), (0, uz1 - 1.03, 4.3, 0.2), (-2.05, zc, 0.24, 1.9), (2.05, zc, 0.24, 1.9)):
        fr.box((cx, py - 0.05, cz), (sw, 0.14, sh))
    fr.box((0, py - 0.05, uz1 + 0.9), (1.2, 0.12, 0.32))
    L.append("  " + fr.ssdl("plaqueFrame", material("#b8862e", 0.35, metal=0.8)))
    L.append("  " + box("plaqueBack", (4.1, 0.12, 1.85), (0, -UP_HY - 0.97, zc), material("#3a2618", 0.7)))

    # --- red lanterns under the lower eave; the glowing shells switch on at night
    lan, caps = MeshBuilder(), MeshBuilder()
    for cx, cy, zc_ in hall_lantern_spots():
        lan.lathe(LANTERN_PROF, (cx, cy, zc_), 16)
        caps.lathe([(0.22, 0.4), (0.24, 0.5), (0.01, 0.52)], (cx, cy, zc_), 12)
        caps.lathe([(0.01, -0.52), (0.24, -0.5), (0.22, -0.4)], (cx, cy, zc_), 12)
        caps.bar((cx, cy, zc_ + 0.5), (cx, cy, ct - 0.97), 0.03, 0.03, up=(1, 0, 0))
        caps.bar((cx, cy, zc_ - 0.5), (cx, cy, zc_ - 0.95), 0.07, 0.07, up=(1, 0, 0))
    L.append("  " + lan.ssdl("lanterns", material("#b8281c", 0.6, extra="emissiveColor: [0.5, 0.08, 0.04]"), shading="smooth", uvs=False))
    L.append("  " + caps.ssdl("lanternCaps", material("#c79a3c", 0.4, metal=0.7), shading="smooth", uvs=False))
    L.append("}")
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- stone balustrades
BAY = 1.9           # post spacing
POST_W = 0.24


def rail_bay(stone_mb, panel_mb, length, xform):
    """One balustrade bay between two posts, centred on the local origin, running along local +x.

    地栿 sill, carved 华板 panel, 盆唇 rail, three 净瓶 vase balusters, round 寻杖 handrail.
    xform maps local points into place (it may shear, which keeps verticals vertical)."""
    h = length / 2
    s_, p_ = MeshBuilder(), MeshBuilder()
    s_.box((0, 0, 0.07), (length + POST_W, 0.3, 0.14))
    p_.box((0, 0, 0.35), (length, 0.12, 0.42))
    s_.box((0, 0, 0.595), (length, 0.18, 0.07))
    vase = [(0.05, 0), (0.07, 0.025), (0.045, 0.06), (0.07, 0.11), (0.085, 0.15), (0.05, 0.195), (0.035, 0.21),
            (0.065, 0.235), (0.07, 0.25)]
    for x in (-h * 0.62, 0, h * 0.62):
        s_.lathe(vase, (x, 0, 0.63), 8)
    s_.lathe([(0.075, -h - 0.05), (0.075, h + 0.05)], (0, 0, 0.93), 10, axis="x")
    stone_mb.extend(s_.transformed(xform))
    panel_mb.extend(p_.transformed(xform))


def rail_post(mb, base):
    """望柱: square shaft with a lotus-and-pearl head."""
    x, y, z = base
    mb.box((x, y, z + 0.56), (POST_W, POST_W, 1.12))
    mb.box((x, y, z + 1.14), (POST_W + 0.04, POST_W + 0.04, 0.05))
    mb.lathe([(0.12, 0), (0.15, 0.04), (0.12, 0.08), (0.15, 0.13), (0.17, 0.18), (0.12, 0.23), (0.14, 0.27),
              (0.11, 0.33), (0.06, 0.38), (0.01, 0.4)], (x, y, z + 1.16), 12)


def drum_stone(mb, c, facing):
    """抱鼓石 at the foot of a stair balustrade: moulded base, a big drum with carved rings, a small scroll."""
    x, y, z = c
    f = facing   # -1: the drum's front points to -y
    mb.box((x, y, z + 0.09), (0.46, 1.3, 0.18))
    mb.box((x, y, z + 0.25), (0.4, 1.2, 0.14))
    mb.box((x, y, z + 0.36), (0.44, 1.26, 0.08))
    prof = [(0.01, -0.16), (0.12, -0.17), (0.14, -0.16), (0.3, -0.16), (0.32, -0.175), (0.34, -0.16),
            (0.4, -0.15), (0.44, -0.11), (0.47, -0.05), (0.475, 0), (0.47, 0.05), (0.44, 0.11), (0.4, 0.15),
            (0.34, 0.16), (0.32, 0.175), (0.3, 0.16), (0.14, 0.16), (0.12, 0.17), (0.01, 0.16)]
    mb.lathe(prof, (x, y + f * 0.1, z + 0.88), 28, axis="x")
    mb.lathe([(0.01, -0.12), (0.17, -0.12), (0.2, -0.06), (0.2, 0.06), (0.17, 0.12), (0.01, 0.12)],
             (x, y + f * 0.55, z + 0.58), 18, axis="x")
    mb.box((x, y + f * 0.32, z + 0.48), (0.3, 0.5, 0.2))


def gen_balustrades():
    """Scene frame. Every stone balustrade: terrace front, the stair slopes, the hall's stone base."""
    T = TERRACE_Z
    pz = PLATFORM_Z
    L = ["// Generated by gen_scene.py: stone balustrades (石栏杆) in scene coordinates. Level runs are",
         "// instanced bays and posts; the stair slopes are sheared bays so their posts stay vertical.",
         "Group {", "  id: root",
         '  Texture { id: stoneTex; source: "assets/stone.png" }',
         '  Texture { id: panelTex; source: "assets/rail_panel.png" }']
    stone = material("#ffffff", 0.85, "stoneTex")
    panel = material("#ffffff", 0.85, "panelTex")
    # level bay + post prefabs
    bs, bp = MeshBuilder(), MeshBuilder()
    rail_bay(bs, bp, BAY - POST_W, lambda q: q)
    L.append("  " + bs.ssdl("baySrc", stone, shading="smooth", visible=False, extra="position: [0, 0, -30]"))
    L.append("  " + bp.ssdl("panelSrc", panel, visible=False, extra="position: [0, 0, -30]"))
    pm = MeshBuilder()
    rail_post(pm, (0, 0, 0))
    L.append("  " + pm.ssdl("postSrc", stone, shading="smooth", visible=False, extra="position: [0, 0, -30]"))
    for nm in ("bay", "panel", "post"):
        L.append(f"  Prefab {{ id: {nm}Pf; source: {nm}Src }}")
    bays, yaws, posts = [], [], []

    def run(p0, p1, z):
        n = max(1, int(round(math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / BAY)))
        yaw = math.degrees(math.atan2(p1[1] - p0[1], p1[0] - p0[0]))
        for i in range(n + 1):
            t = i / n
            posts.append((p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, z))
            if i < n:
                tm = (i + 0.5) / n
                bays.append((p0[0] + (p1[0] - p0[0]) * tm, p0[1] + (p1[1] - p0[1]) * tm, z))
                yaws.append(yaw)
    xs0 = STAIR_W / 2 + 0.3
    for sx in (-1, 1):
        run((sx * xs0, 0.3), (sx * (xs0 + 1.9 * 19), 0.3), T)
    # the hall's stone base: front either side of its steps, both sides, the back
    hy0, hy1 = HALL_Y - 12.3, HALL_Y + 12.3
    for sx in (-1, 1):
        run((sx * 8.45, hy0), (sx * 16.8, hy0), pz)
        run((sx * 16.8, hy0), (sx * 16.8, hy1), pz)
    run((-16.8, hy1), (16.8, hy1), pz)
    for nm, src in (("bay", "bay"), ("panel", "panel")):
        for k in range(0, len(bays), 512):
            L.append(f"  Instances {{ id: {nm}s{k // 512}; prefab: {src}Pf; positions: {vlist(bays[k:k + 512])}; "
                     f"rotations_z: {slist(yaws[k:k + 512])} }}")
    # stair slopes: sheared bays and vertical posts on the stair cheeks
    ss, sp, sposts = MeshBuilder(), MeshBuilder(), MeshBuilder()
    y_bot, y_top = STAIR_Y0 + 0.2, 0.3
    slope = (T + 0.02 - 0.12) / (-STAIR_Y0 + 0.2)

    def zc(y): return min(T, 0.12 + (y - STAIR_Y0 + 0.2) * slope)
    for sx in (-1, 1):
        x = sx * xs0
        ys = [y_bot + i * (y_top - y_bot) / 3 for i in range(4)]
        for y in ys[:-1]:
            rail_post(sposts, (x, y, zc(y)))
        for ya, yb in zip(ys, ys[1:]):
            yc = (ya + yb) / 2
            k_ = (zc(yb) - zc(ya)) / (yb - ya)
            rail_bay(ss, sp, (yb - ya) - POST_W,
                     lambda q, x=x, yc=yc, k_=k_: (x + q[1], yc + q[0], zc(yc) + q[2] + k_ * q[0]))
        drum_stone(sposts, (x, STAIR_Y0 - 0.35, 0.0), -1)
    L.append("  " + ss.ssdl("stairRails", stone, shading="smooth"))
    L.append("  " + sp.ssdl("stairPanels", panel))
    L.append("  " + sposts.ssdl("stairPostsAndDrums", stone, shading="smooth"))
    L.append(f"  Instances {{ id: posts; prefab: postPf; positions: {vlist(posts)} }}")
    L.append("}")
    return "\n".join(L) + "\n"


STONE_LANTERN_SPOTS = [(sx * 7.0, y) for y in (3.5, 12.5) for sx in (-1, 1)]
PLAZA_LANTERN_SPOTS = [(sx * 13.0, y) for y in (-16.0, -32.0, -48.0) for sx in (-1, 1)]


def stone_lantern(mb):
    """石灯笼: moulded base, octagonal shaft, a fire chamber with dark windows, a flared cap and finial."""
    mb.box((0, 0, 0.1), (0.8, 0.8, 0.2))
    mb.lathe([(0.34, 0.2), (0.3, 0.3), (0.2, 0.36), (0.17, 0.4), (0.17, 1.35), (0.26, 1.42), (0.36, 1.5), (0.36, 1.56)], (0, 0, 0), 8)
    mb.box((0, 0, 1.6), (0.72, 0.72, 0.08))
    for dx, dy in ((0.25, 0.25), (-0.25, 0.25), (0.25, -0.25), (-0.25, -0.25)):
        mb.box((dx, dy, 1.93), (0.14, 0.14, 0.6))
    mb.box((0, 0, 1.93), (0.4, 0.4, 0.6))
    mb.lathe([(0.62, 2.23), (0.66, 2.27), (0.5, 2.36), (0.22, 2.56), (0.12, 2.66), (0.16, 2.72), (0.12, 2.82),
              (0.05, 2.95), (0.01, 3.0)], (0, 0, 0), 4)


def lantern_windows(spots, z0):
    """The glowing panes of every stone lantern, as one mesh in scene coordinates."""
    mb = MeshBuilder()
    for x, y in spots:
        mb.box((x, y, z0 + 1.93), (0.44, 0.44, 0.5))
    return mb


def gen_terrace():
    """Scene frame (z = 0 lower plaza). Terrace, main stairs, balustrades, planters, shrubs."""
    T = TERRACE_Z
    L = ["// Generated by gen_scene.py: the raised terrace, the broad front stairs, stone balustrades,",
         "// paving, planters and shrubs. Written in scene coordinates.",
         "Group {", "  id: root",
         '  Texture { id: pavingTex; source: "assets/paving.png" }',
         '  Texture { id: leafTex; source: "assets/foliage.png" }',
         '  Texture { id: stoneTex; source: "assets/stone.png" }']
    stone = material("#ffffff", 0.9, "stoneTex")
    # 香炉: a bronze tripod censer with a pagoda lid on the axis, incense smoke rising from it
    bz = MeshBuilder()
    cy = 7.5
    bz.lathe([(0.01, 0.3), (0.3, 0.3), (0.55, 0.35), (0.7, 0.55), (0.72, 0.8), (0.62, 1.0), (0.68, 1.05), (0.66, 1.1),
              (0.01, 1.11)], (0, cy, T), 24)
    bz.lathe([(0.52, 1.1), (0.56, 1.14), (0.22, 1.32), (0.26, 1.46), (0.1, 1.7), (0.14, 1.8), (0.04, 2.05), (0.01, 2.15)],
             (0, cy, T), 16)
    for k in range(3):
        a = 2 * math.pi * k / 3 + math.pi / 2
        bz.bar((0.45 * math.cos(a), cy + 0.45 * math.sin(a), T + 0.42), (0.55 * math.cos(a), cy + 0.55 * math.sin(a), T + 0.3),
               0.12, 0.12)
    for sx in (-1, 1):
        bz.bar((sx * 0.62, cy, T + 1.0), (sx * 0.66, cy, T + 1.38), 0.08, 0.14)
        bz.bar((sx * 0.66, cy, T + 1.38), (sx * 0.5, cy, T + 1.42), 0.08, 0.14)
    L.append("  " + bz.ssdl("censer", material("#5d4a34", 0.42, metal=0.8), shading="smooth", uvs=False))
    L.append("  " + box("censerPlinth", (1.7, 1.7, 0.3), (0, cy, T + 0.15), stone))
    L.append("  " + box("terraceBlock", (2 * TERRACE_HX + 1.2, TERRACE_D + 0.5, T - 0.02), (0, TERRACE_D / 2 + 0.25, (T - 0.02) / 2), material("#a9a499", 0.95)))
    pav = MeshBuilder()
    for (x0, x1, y0, y1, z) in ((-TERRACE_HX, TERRACE_HX, 0, TERRACE_D, T + 0.006), (-42, 42, -64, STAIR_Y0, 0.004),
                                (-42, -STAIR_W / 2 - 0.6, STAIR_Y0, 0, 0.004), (STAIR_W / 2 + 0.6, 42, STAIR_Y0, 0, 0.004)):
        pav.rect((x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), (0, 0, 1),
                 ((x0 / 4, -y0 / 4), (x1 / 4, -y0 / 4), (x1 / 4, -y1 / 4), (x0 / 4, -y1 / 4)))
    L.append("  " + pav.ssdl("paving", material("#ffffff", 0.9, "pavingTex")))
    L.append(f"  Stairs {{ id: mainStairs; steps: {STEP_N}; rise: {num(STEP_RISE)}; run: {num(STEP_RUN)}; "
             f"width: {num(STAIR_W)}; position: [0, {num(STAIR_Y0)}, 0]; rotation: {vec(qz(90))}; "
             f"{material('#d6d1c7', 0.9)} }}")
    # 垂带: sloped side curbs of the stairs, balustrades sit on them
    cheek = MeshBuilder()
    for sx in (-1, 1):
        x = sx * (STAIR_W / 2 + 0.3)
        poly = [(STAIR_Y0 - 0.2, 0), (0, 0), (0, T + 0.02), (STAIR_Y0 - 0.2, 0.12)]
        cheek.prism(poly, (x, 0, 0), (0, 1, 0), (0, 0, 1), (1, 0, 0), 0.6)
    L.append("  " + cheek.ssdl("stairCheeks", stone))
    for sx in (-1, 1):
        x0 = sx * (STAIR_W / 2 + 0.6)
        x1 = sx * (TERRACE_HX + 0.6)
        cx, w_ = (x0 + x1) / 2, abs(x1 - x0)
        L.append("  " + box(f"terraceCoping{'WE'[sx > 0]}", (w_, 0.5, 0.2), (cx, -0.05, T - 0.08), stone))
        L.append("  " + box(f"terracePlinth{'WE'[sx > 0]}", (w_, 0.35, 0.22), (cx, -0.12, 0.11), stone))
        L.append("  " + box(f"terraceFace{'WE'[sx > 0]}", (w_, 0.2, T - 0.38), (cx, -0.06, 0.22 + (T - 0.38) / 2), stone))
    # 院墙: ochre courtyard walls with a grey tiled coping, up both sides and across the back
    wall, cope, band = MeshBuilder(), MeshBuilder(), MeshBuilder()
    wh = 4.0
    runs = [((-TERRACE_HX - 0.3, 0.6), (-TERRACE_HX - 0.3, TERRACE_D + 0.3)),
            ((TERRACE_HX + 0.3, 0.6), (TERRACE_HX + 0.3, TERRACE_D + 0.3)),
            ((-TERRACE_HX - 0.3, TERRACE_D + 0.3), (TERRACE_HX + 0.3, TERRACE_D + 0.3))]
    for (xa, ya), (xb, yb) in runs:
        a3, b3 = (xa, ya, T + wh / 2), (xb, yb, T + wh / 2)
        wall.bar(a3, b3, 0.8, wh)
        band.bar((xa, ya, T + 0.35), (xb, yb, T + 0.35), 0.9, 0.7)
        band.bar((xa, ya, T + wh - 0.25), (xb, yb, T + wh - 0.25), 0.86, 0.3)
        d = (xb - xa, yb - ya)
        Ld = math.hypot(*d)
        U = (-d[1] / Ld, d[0] / Ld, 0)
        W_ = (d[0] / Ld, d[1] / Ld, 0)
        mid = ((xa + xb) / 2, (ya + yb) / 2, T + wh)
        cope.prism([(-0.75, -0.05), (0.75, -0.05), (0.75, 0.05), (0.0, 0.62), (-0.75, 0.05)], mid, U, (0, 0, 1), W_, Ld + 1.4)
    L.append("  " + wall.ssdl("courtWalls", material("#c89452", 0.92)))
    L.append("  " + band.ssdl("courtWallBands", material("#8f3a26", 0.8)))
    L.append("  " + cope.ssdl("courtWallCoping", material("#5f5a54", 0.75), uvs=False))
    # central granite path (神道) on the terrace and across the lower plaza
    path = MeshBuilder()
    for (y0, y1, z) in ((0.2, HALL_Y - 14.6, T + 0.03), (-64, STAIR_Y0 - 0.1, 0.03)):
        path.rect((-3, y0, z), (3, y0, z), (3, y1, z), (-3, y1, z), (0, 0, 1),
                  ((0, -y0 / 3), (2, -y0 / 3), (2, -y1 / 3), (0, -y1 / 3)))
        for sx in (-1, 1):
            path.box((sx * 3.1, (y0 + y1) / 2, z), (0.2, y1 - y0, 0.08))
    L.append("  " + path.ssdl("centralPath", material("#9a948a", 0.8, "pavingTex")))
    lan = MeshBuilder()
    stone_lantern(lan)
    L.append("  " + lan.ssdl("stoneLanternSrc", stone, shading="smooth", visible=False, extra="position: [0, 0, -30]"))
    L.append("  Prefab { id: stoneLanternPf; source: stoneLanternSrc }")
    L.append(f"  Instances {{ id: stoneLanterns; prefab: stoneLanternPf; positions: "
             f"{vlist([(x, y, T) for x, y in STONE_LANTERN_SPOTS] + [(x, y, 0) for x, y in PLAZA_LANTERN_SPOTS])} }}")
    # planters on the terrace, left and right of the hall front
    for sx, nm in ((-1, "W"), (1, "E")):
        L.append("  " + box(f"planter{nm}", (18, 3.2, 0.55), (sx * 19, 5.6, T + 0.275), material("#b8b3a9", 0.9)))
        L.append("  " + box(f"hedgeBed{nm}", (8, 2.2, 0.35), (sx * 21, 22.5, T + 0.175), material("#b8b3a9", 0.9)))
    L.append("  " + box("signBoard", (1.7, 0.12, 0.95), (9.8, 12.0, T + 0.95), material("#b9b546", 0.7)))
    L.append("  " + box("signPostL", (0.08, 0.08, 0.5), (9.1, 12.0, T + 0.25), material("#555555", 0.5)))
    L.append("  " + box("signPostR", (0.08, 0.08, 0.5), (10.5, 12.0, T + 0.25), material("#555555", 0.5)))
    # shrubs: red-leaf and green, instanced
    rnd = random.Random(11)
    red, green = [], []
    for sx in (-1, 1):
        for i in range(16):
            x = sx * (10.6 + i * 1.12 + rnd.uniform(-0.2, 0.2))
            (red if (i % 3 != 1) else green).append((x, 5.0 + rnd.uniform(-0.3, 0.3), T + 0.85))
            green.append((x + sx * 0.6, 6.4 + rnd.uniform(-0.2, 0.2), T + 0.8))
        for i in range(6):
            (red if i % 2 else green).append((sx * (17.8 + i * 1.3), 22.5, T + 0.62))
    L.append(f"  Sphere {{ id: redShrubSrc; radius: 0.75; segments: 16; scale: [1, 1, 0.75]; position: [0, 0, -20]; visible: false; "
             f"{material('#9e3a2c', 0.85, 'leafTex')} }}")
    L.append(f"  Sphere {{ id: greenShrubSrc; radius: 0.75; segments: 16; scale: [1, 1, 0.75]; position: [0, 0, -20]; visible: false; "
             f"{material('#7f9a4c', 0.85, 'leafTex')} }}")
    L.append("  Prefab { id: redShrubPf; source: redShrubSrc }")
    L.append("  Prefab { id: greenShrubPf; source: greenShrubSrc }")
    L.append(f"  Instances {{ id: redShrubs; prefab: redShrubPf; positions: {vlist(red)}; "
             f"scales: {vlist([(s, s, s * 0.75) for s in [rnd.uniform(0.8, 1.15) for _ in red]])} }}")
    L.append(f"  Instances {{ id: greenShrubs; prefab: greenShrubPf; positions: {vlist(green)}; "
             f"scales: {vlist([(s, s, s * 0.75) for s in [rnd.uniform(0.75, 1.1) for _ in green]])} }}")
    L.append("}")
    return "\n".join(L) + "\n"


def gen_cloud_tree():
    """12 m tree built with constants; instantiations vary it with the root Group's scale."""
    tall = 12.0
    lobes = [(-0.9, 0.12, 0.40, 1.25, 0.95), (0.95, -0.2, 0.47, 1.15, 0.9), (-0.55, -0.1, 0.58, 1.35, 1.0),
             (0.65, 0.25, 0.66, 1.25, 0.95), (-0.3, 0.3, 0.76, 1.3, 1.0), (0.4, -0.25, 0.86, 1.15, 0.95),
             (0.0, 0.0, 0.96, 0.95, 0.8)]
    L = ["// A cloud-pruned tree (造型树): trunk, short branches and stacked foliage lobes, 12 m tall.",
         "// Local origin = foot of the trunk. Vary it per placement with the instance's scale.",
         "Group {", "  id: root",
         '  Texture { id: leafTex; source: "assets/foliage.png" }',
         f"  Cylinder {{ id: trunk; radius: 0.26; height: {num(tall * 0.7)}; segments: 14; position: [0, 0, {num(tall * 0.35)}]; "
         f"{material('#5b4b3e', 0.95)} }}"]
    for i, (x, y, zf_, r, rz) in enumerate(lobes):
        L.append(f"  Tube {{ id: branch{i}; path: {vlist([(0, 0, tall * (zf_ - 0.12)), (x * 0.6, y * 0.6, tall * (zf_ - 0.04))])}; "
                 f"radius: 0.1; segments: 8; {material('#5b4b3e', 0.95)} }}")
        L.append(f"  Sphere {{ id: lobe{i}; radius: 1; segments: 20; position: {vec((x, y, tall * zf_))}; "
                 f"scale: {vec((r, r * 0.9, rz))}; {material('#7f9c4a', 0.9, 'leafTex')} }}")
        for k, (dx, dz) in enumerate(((0.7, -0.25), (-0.6, 0.3))):
            L.append(f"  Sphere {{ id: puff{i}_{k}; radius: 1; segments: 14; position: {vec((x + dx * r, y + 0.2, tall * zf_ + dz))}; "
                     f"scale: {vec((r * 0.55, r * 0.5, rz * 0.55))}; {material('#89a452', 0.9, 'leafTex')} }}")
    L.append("}")
    return "\n".join(L) + "\n"


def gen_bonsai():
    L = ["// A small shaped pine in front of the hall. Local origin = foot of the trunk.",
         "Group {", "  id: root",
         '  Texture { id: leafTex; source: "assets/foliage.png" }',
         f"  Tube {{ id: trunk; path: [[0, 0, 0], [0.2, 0, 0.9], [-0.15, 0.1, 1.7], [0.25, 0, 2.5], [0, 0, 3.1]]; radius: 0.12; segments: 10; "
         f'smooth: "catmullrom"; samples: 4; {material("#4d3b2e", 0.95)} }}']
    pads = [(0.7, 0.1, 1.4, 1.0), (-0.6, -0.1, 2.0, 0.9), (0.4, 0.1, 2.6, 0.8), (0, 0, 3.2, 0.65)]
    for i, (x, y, z, r) in enumerate(pads):
        L.append(f"  Sphere {{ id: pad{i}; radius: 1; segments: 16; position: [{num(x)}, {num(y)}, {num(z)}]; "
                 f"scale: [{num(r)}, {num(r * 0.8)}, {num(r * 0.38)}]; {material('#5c7a3a', 0.9, 'leafTex')} }}")
    L.append("}")
    return "\n".join(L) + "\n"


def small_bracket():
    """A compact bracket set for the flanking buildings; outward = -y (to the right of the path)."""
    br = MeshBuilder()
    br.box((0, 0, 0.08), (0.26, 0.26, 0.16))
    br.bar((0, 0.2, 0.22), (0, -0.4, 0.22), 0.12, 0.14)
    br.box((0, 0, 0.22), (0.7, 0.12, 0.14))
    for x, y in ((-0.32, 0), (0.32, 0), (0, -0.36)):
        br.box((x, y, 0.34), (0.16, 0.16, 0.1))
    br.bar((0, 0.15, 0.6), (0, -0.7, 0.36), 0.12, 0.13)
    br.box((0, 0, 0.5), (0.9, 0.14, 0.24))
    br.box((0, -0.5, 0.52), (0.9, 0.12, 0.14))
    return br


def facade_x(mb, x, y0, y1, z0, z1, outward, u=(0.0, 1.0), v_rep=1.0):
    """Textured quad in the plane x = const, seen from +x (outward 1) or -x (outward -1)."""
    a, b = (y0, y1) if outward > 0 else (y1, y0)
    mb.rect((x, a, z0), (x, b, z0), (x, b, z1), (x, a, z1), (outward, 0, 0),
            ((u[0], 0), (u[1], 0), (u[1], v_rep), (u[0], v_rep)))


def gen_side_hall():
    """Left side hall: double eave, faces east (+x). Local origin on the terrace at its centre."""
    L = ["// Generated by gen_scene.py: west side hall (配殿), two eaves, facing east toward the courtyard.",
         "// Front porch of red columns with painted beams and braces, doors in the middle bays, lattice windows.",
         "Group {", "  id: root",
         '  Texture { id: tileTex; source: "assets/tiles.png" }',
         '  Texture { id: rafterTex; source: "assets/rafters.png" }',
         '  Texture { id: windowTex; source: "assets/window_bay.png" }',
         '  Texture { id: doorTex; source: "assets/door_bay.png" }',
         '  Texture { id: latticeTex; source: "assets/lattice_strip.png" }',
         '  Texture { id: beamTex; source: "assets/beam_paint.png" }',
         '  Texture { id: bracketTex; source: "assets/bracket_paint.png" }',
         '  Texture { id: stoneTex; source: "assets/stone.png" }',
         '  Texture { id: brickTex; source: "assets/brick.png" }']
    stone = material("#ffffff", 0.88, "stoneTex")
    lacquer = material("#7a2a1c", 0.55)
    hx, hy = 6.0, 12.0     # body: x across (depth), y along
    px = hx + 1.5          # porch column line
    L.append("  " + box("base", (2 * hx + 4.2, 2 * hy + 2.4, 0.6), (0.9, 0, 0.3), stone))
    L.append("  " + box("baseLip", (2 * hx + 4.4, 2 * hy + 2.6, 0.08), (0.9, 0, 0.56), stone))
    L.append(f"  Stairs {{ id: steps; steps: 3; rise: 0.2; run: 0.35; width: 8; position: [{num(px + 1.65)}, 0, 0]; "
             f"rotation: {vec(qz(180))}; {material('#c9c3b8', 0.9)} }}")
    L.append("  " + box("body", (2 * hx, 2 * hy, 4.2), (0, 0, 2.7), material("#5a3222", 0.85)))
    fac, doors, sill, frames, trans = (MeshBuilder() for _ in range(5))
    bay = 2 * hy / 6
    for i in range(6):
        y0, y1 = -hy + i * bay + 0.25, -hy + (i + 1) * bay - 0.25
        for y in (y0 + 0.08, y1 - 0.08):
            frames.box((hx + 0.08, y, 2.65), (0.18, 0.16, 4.1))
        frames.box((hx + 0.08, (y0 + y1) / 2, 4.1), (0.2, y1 - y0, 0.16))
        facade_x(trans, hx + 0.03, y0 + 0.16, y1 - 0.16, 4.18, 4.7, 1, (0, (y1 - y0) / 3))
        if i in (2, 3):
            facade_x(doors, hx + 0.03, y0 + 0.16, y1 - 0.16, 0.65, 4.02, 1)
        else:
            sill.box((hx - 0.1, (y0 + y1) / 2, 1.1), (0.5, y1 - y0 - 0.3, 1.0))
            frames.box((hx + 0.12, (y0 + y1) / 2, 1.63), (0.4, y1 - y0 - 0.2, 0.07))
            facade_x(fac, hx + 0.03, y0 + 0.16, y1 - 0.16, 1.66, 4.02, 1)
    L.append("  " + fac.ssdl("eastWindows", material("#ffffff", 0.7, "windowTex")))
    L.append("  " + doors.ssdl("eastDoors", material("#ffffff", 0.7, "doorTex")))
    L.append("  " + trans.ssdl("eastTransom", material("#ffffff", 0.7, "latticeTex")))
    L.append("  " + sill.ssdl("sillWalls", material("#ffffff", 0.95, "brickTex")))
    L.append("  " + frames.ssdl("frames", lacquer))
    # porch columns, painted beam, braces
    cols = [(px, -hy + i * bay, 0.6) for i in range(7)] + [(hx, sy * hy, 0.6) for sy in (-1, 1)]
    L.append(f"  Lathe {{ id: colSrc; profile: {vlist([(0.24, 0, 0), (0.24, 0, 0.5), (0.225, 0, 4.2)])}; segments: 20; "
             f"position: [0, 0, -30]; visible: false; {material('#8a2c1c', 0.5)} }}")
    L.append("  Prefab { id: colPf; source: colSrc }")
    L.append(f"  Instances {{ id: porchColumns; prefab: colPf; positions: {vlist(cols)} }}")
    cb = MeshBuilder()
    cb.box((0, 0, 0.05), (0.66, 0.66, 0.1))
    cb.lathe([(0.32, 0.1), (0.33, 0.14), (0.3, 0.19), (0.25, 0.22), (0.01, 0.22)], (0, 0, 0), 16)
    L.append("  " + cb.ssdl("colBaseSrc", stone, shading="smooth", visible=False, extra="position: [0, 0, -30]"))
    L.append("  Prefab { id: colBasePf; source: colBaseSrc }")
    L.append(f"  Instances {{ id: columnBases; prefab: colBasePf; positions: {vlist([(x, y, 0.56) for x, y, _ in cols])} }}")
    L.append("  " + box("porchBeam", (0.36, 2 * hy + 0.6, 0.45), (px, 0, 4.6), lacquer))
    L.append("  " + box("porchBeamLow", (0.3, 2 * hy + 0.3, 0.26), (px, 0, 4.05), lacquer))
    L.append("  " + box("porchTies", (px - hx, 2 * hy + 0.3, 0.2), ((px + hx) / 2, 0, 4.7), lacquer))
    pb = MeshBuilder()
    for i in range(6):
        y0, y1 = -hy + i * bay + 0.25, -hy + (i + 1) * bay - 0.25
        facade_x(pb, px + 0.182, y0, y1, 4.4, 4.8, 1)
        facade_x(pb, px + 0.152, y0, y1, 3.94, 4.16, 1)
    L.append("  " + pb.ssdl("porchPaint", material("#ffffff", 0.6, "beamTex")))
    brace = MeshBuilder()
    sil = [(0, 0), (0.85, 0), (0.8, -0.08), (0.62, -0.1), (0.48, -0.16), (0.3, -0.22), (0.14, -0.34), (0, -0.4)]
    for i in range(1, 6):
        for sy in (-1, 1):
            brace.prism([(u * sy, v) for u, v in sil], (px, -hy + i * bay, 3.92), (0, 1, 0), (0, 0, 1), (1, 0, 0), 0.12)
    L.append("  " + brace.ssdl("braces", material("#ffffff", 0.6, "bracketTex")))
    L.append("  " + small_bracket().ssdl("bracketSrc", material("#ffffff", 0.65, "bracketTex"), visible=False,
                                         extra="position: [0, 0, -30]"))
    L.append("  Prefab { id: bracketPf; source: bracketSrc }")
    L.append(f"  Instances {{ id: brackets; prefab: bracketPf; placement: \"along_path\"; "
             f"path: {vlist([(px, hy, 4.85), (px, -hy, 4.85)])}; step: 1.0; alignToPath: true }}")
    # upper storey
    L.append("  " + box("upperBody", (2 * hx - 2.4, 2 * hy - 2.4, 2.6), (0, 0, 5.9), material("#5a3222", 0.85)))
    ul = MeshBuilder()
    facade_x(ul, hx - 1.18, -hy + 1.6, hy - 1.6, 5.0, 6.9, 1, (0, (2 * hy - 3.2) / 3))
    facade_x(ul, -(hx - 1.18), -hy + 1.6, hy - 1.6, 5.0, 6.9, -1, (0, (2 * hy - 3.2) / 3))
    L.append("  " + ul.ssdl("upperLattice", material("#ffffff", 0.7, "latticeTex")))
    lower = curved_roof(hy + 2.2, hx + 2.9, 4.95, 1.3, 3.8, lift=0.5, flare=0.4, decay=3.4, nd=6, ns=36,
                        p=(0.7, 0.3), ridge=False, thick=0.25)
    lower_lines = roof_block("lower", lower, rotate=True, ridge_scale=0.6)
    L += ["  " + s_ for s_ in lower_lines]
    upper = curved_roof(hy + 0.6, hx + 0.6, 7.2, 3.6, hx + 0.6, d_gable=2.4, lift=0.6, flare=0.45, nd=12, ns=40)
    L += ["  " + s_ for s_ in roof_block("upper", upper, rotate=True, ridge_scale=0.7)]
    gf = gable_face(hy + 0.6, hx + 0.6, 2.4, upper["zf"], hx + 0.6, inset=0.5)
    L.append("  " + rot90(gf).ssdl("gables", material("#7a3a28", 0.85), uvs=False))
    rh = upper["ridge_half"]
    L.append(f"  Sweep {{ id: ridge; profile: {vlist([[x * 0.6, 0, z * 0.6] for x, _, z in RIDGE_PROFILE])}; "
             f"path: {vlist([(0, -rh - 0.2, upper['ridge_z'] - 0.1), (0, rh + 0.2, upper['ridge_z'] - 0.1)])}; cap: true; flat: true; {RIDGE} }}")
    L.append("}")
    return "\n".join(L) + "\n"


def gen_gable_hall():
    """Right building: hip-gable roof with its white, red-framed gable facing south (-y)."""
    L = ["// Generated by gen_scene.py: east building, its hip-gable end (white plaster, red timber) facing the plaza.",
         "// Red corner and front columns, a lattice door between two windows, porch roof, bracket sets, 悬鱼.",
         "Group {", "  id: root",
         '  Texture { id: tileTex; source: "assets/tiles.png" }',
         '  Texture { id: rafterTex; source: "assets/rafters.png" }',
         '  Texture { id: timberTex; source: "assets/timber_wall.png" }',
         '  Texture { id: windowTex; source: "assets/window_bay.png" }',
         '  Texture { id: doorTex; source: "assets/door_bay.png" }',
         '  Texture { id: bracketTex; source: "assets/bracket_paint.png" }',
         '  Texture { id: stoneTex; source: "assets/stone.png" }',
         '  Texture { id: brickTex; source: "assets/brick.png" }']
    stone = material("#ffffff", 0.88, "stoneTex")
    lacquer = material("#7a2a1c", 0.55)
    hx, hy = 4.6, 5.2
    L.append("  " + box("base", (2 * hx + 1.6, 2 * hy + 1.6, 0.5), (0, 0, 0.25), stone))
    L.append("  " + box("baseLip", (2 * hx + 1.8, 2 * hy + 1.8, 0.08), (0, 0, 0.46), stone))
    L.append(f"  Stairs {{ id: steps; steps: 3; rise: 0.167; run: 0.32; width: 3.2; position: [0, {num(-hy - 0.8)}, 0]; "
             f"rotation: {vec(qz(90))}; {material('#c9c3b8', 0.9)} }}")
    L.append("  " + box("body", (2 * hx, 2 * hy, 5.8), (0, 0, 3.4), material("#e6e2d8", 0.9)))
    wall = MeshBuilder()
    # upper walls (above the porch roof) keep the white-and-red timber pattern on every face
    wall.rect((-hx, -hy - 0.02, 3.6), (hx, -hy - 0.02, 3.6), (hx, -hy - 0.02, 6.3), (-hx, -hy - 0.02, 6.3), (0, -1, 0),
              ((0, 0), (2 * hx / 3, 0), (2 * hx / 3, 2.7 / 3), (0, 2.7 / 3)))
    for sx in (-1, 1):
        facade_x(wall, sx * (hx + 0.02), -hy, hy, 0.5, 6.3, sx, (0, 2 * hy / 3), 5.8 / 3)
    wall.rect((hx, hy + 0.02, 0.5), (-hx, hy + 0.02, 0.5), (-hx, hy + 0.02, 6.3), (hx, hy + 0.02, 6.3), (0, 1, 0),
              ((0, 0), (2 * hx / 3, 0), (2 * hx / 3, 5.8 / 3), (0, 5.8 / 3)))
    L.append("  " + wall.ssdl("timberWalls", material("#ffffff", 0.9, "timberTex")))
    # south face ground floor: door between two windows over sill walls, red frames
    f, win, door, sill = (MeshBuilder() for _ in range(4))
    fy = -hy - 0.03
    bays = [(-hx + 0.3, -1.6), (-1.6, 1.6), (1.6, hx - 0.3)]
    for i, (x0, x1) in enumerate(bays):
        for x in (x0 + 0.08, x1 - 0.08):
            f.box((x, fy - 0.05, 2.05), (0.16, 0.14, 3.1))
        f.box(((x0 + x1) / 2, fy - 0.05, 3.5), (x1 - x0, 0.16, 0.18))
        if i == 1:
            door.rect((x0 + 0.16, fy, 0.5), (x1 - 0.16, fy, 0.5), (x1 - 0.16, fy, 3.42), (x0 + 0.16, fy, 3.42), (0, -1, 0),
                      ((0.25, 0), (0.75, 0), (0.75, 1), (0.25, 1)))
        else:
            sill.box(((x0 + x1) / 2, fy + 0.12, 0.95), (x1 - x0 - 0.3, 0.3, 0.9))
            f.box(((x0 + x1) / 2, fy - 0.06, 1.43), (x1 - x0 - 0.2, 0.36, 0.07))
            win.rect((x0 + 0.16, fy, 1.46), (x1 - 0.16, fy, 1.46), (x1 - 0.16, fy, 3.42), (x0 + 0.16, fy, 3.42), (0, -1, 0),
                     ((0, 0), (0.5, 0), (0.5, 1), (0, 1)))
    L.append("  " + f.ssdl("frames", lacquer))
    L.append("  " + win.ssdl("windows", material("#ffffff", 0.7, "windowTex")))
    L.append("  " + door.ssdl("door", material("#ffffff", 0.7, "doorTex")))
    L.append("  " + sill.ssdl("sillWalls", material("#ffffff", 0.95, "brickTex")))
    cols = [(sx * hx, sy * hy, 0.5) for sx in (-1, 1) for sy in (-1, 1)] + [(sx * 1.6, -hy - 0.1, 0.5) for sx in (-1, 1)]
    L.append(f"  Lathe {{ id: colSrc; profile: {vlist([(0.22, 0, 0), (0.22, 0, 0.5), (0.205, 0, 3.6)])}; segments: 18; "
             f"position: [0, 0, -30]; visible: false; {material('#8a2c1c', 0.5)} }}")
    L.append("  Prefab { id: colPf; source: colSrc }")
    L.append(f"  Instances {{ id: columns; prefab: colPf; positions: {vlist(cols)} }}")
    L.append("  " + box("frontBeam", (2 * hx + 0.4, 0.3, 0.3), (0, -hy - 0.12, 3.75), lacquer))
    lower = curved_roof(hy + 1.8, hx + 1.8, 3.9, 0.9, 2.2, lift=0.4, flare=0.35, decay=2.2, nd=5, ns=32,
                        p=(0.7, 0.3), ridge=False, thick=0.22)
    L += ["  " + s_ for s_ in roof_block("porch", lower, rotate=True, ridge_scale=0.5)]
    L.append("  " + small_bracket().ssdl("bracketSrc", material("#ffffff", 0.65, "bracketTex"), visible=False,
                                         extra="position: [0, 0, -30]"))
    L.append("  Prefab { id: bracketPf; source: bracketSrc }")
    ring = [(-hx - 0.1, -hy - 0.1, 5.75), (hx + 0.1, -hy - 0.1, 5.75), (hx + 0.1, hy + 0.1, 5.75), (-hx - 0.1, hy + 0.1, 5.75),
            (-hx - 0.1, -hy - 0.09, 5.75)]
    L.append(f"  Instances {{ id: brackets; prefab: bracketPf; placement: \"along_path\"; path: {vlist(ring)}; step: 0.95; "
             f"alignToPath: true }}")
    L.append("  " + box("capBeam", (2 * hx + 0.5, 2 * hy + 0.5, 0.3), (0, 0, 5.6), lacquer))
    A, B = hy + 1.5, hx + 1.5
    upper = curved_roof(A, B, 6.4, 4.0, B, d_gable=1.9, lift=0.55, flare=0.45, nd=12, ns=40)
    L += ["  " + s_ for s_ in roof_block("upper", upper, rotate=True, ridge_scale=0.6)]
    gf = gable_face(A, B, 1.9, upper["zf"], B, inset=0.35, drop=0.6)
    L.append("  " + rot90(gf).ssdl("gables", material("#ffffff", 0.9, "timberTex")))
    # 悬鱼: the hanging ornament under the gable apex, both ends
    fish = MeshBuilder()
    for sy in (-1, 1):
        yg = sy * (A - 1.9 - 0.35 + 0.14)
        zt = upper["zf"](B) - 0.4
        fish.prism([(-0.28, 0), (0.28, 0), (0.18, -0.35), (0.3, -0.6), (0, -0.95), (-0.3, -0.6), (-0.18, -0.35)],
                   (0, yg, zt), (1, 0, 0), (0, 0, 1), (0, 1, 0), 0.08)
    L.append("  " + fish.ssdl("hangingFish", material("#b8862e", 0.45, metal=0.6), uvs=False))
    rh = upper["ridge_half"]
    L.append(f"  Sweep {{ id: ridge; profile: {vlist([[x * 0.55, 0, z * 0.55] for x, _, z in RIDGE_PROFILE])}; "
             f"path: {vlist([(0, -rh - 0.2, upper['ridge_z'] - 0.1), (0, rh + 0.2, upper['ridge_z'] - 0.1)])}; cap: true; flat: true; {RIDGE} }}")
    L.append("}")
    return "\n".join(L) + "\n"


def gen_corridor():
    L = ["// Generated by gen_scene.py: a covered corridor (廊) linking the side buildings to the hall.",
         "// 18 m long along x. Local origin on the terrace at its centre.",
         "Group {", "  id: root",
         '  Texture { id: tileTex; source: "assets/tiles.png" }',
         '  Texture { id: rafterTex; source: "assets/rafters.png" }',
         '  Texture { id: latticeTex; source: "assets/lattice_strip.png" }']
    L.append("  " + box("base", (18.6, 5.4, 0.4), (0, 0, 0.2), material(STONE, 0.9)))
    L.append("  " + box("wall", (18, 0.4, 3.0), (0, 1.6, 1.9), material("#e0dbd0", 0.9)))
    L.append("  " + box("beam", (18, 4.6, 0.3), (0, 0, 3.25), material("#5a2a1e", 0.8)))
    L.append(f"  Cylinder {{ id: postSrc; radius: 0.16; height: 3.0; segments: 12; position: [0, 0, -20]; visible: false; {material(COLUMN, 0.6)} }}")
    L.append("  Prefab { id: postPf; source: postSrc }")
    L.append(f"  Instances {{ id: posts; prefab: postPf; placement: \"grid\"; origin: [-8.5, -2.1, 1.9]; spacing: [3.4, 3.7]; columns: 6; count: 12 }}")
    roof = curved_roof(10.0, 3.4, 3.4, 1.9, 3.4, d_gable=0.0001, lift=0.25, flare=0.2, decay=0.0001, nd=8, ns=40)
    L += ["  " + s for s in roof_block("roof", roof)]
    gf = gable_face(10.0, 3.4, 0.0001, roof["zf"], 3.4, inset=0.4, drop=0.6)
    L.append("  " + gf.ssdl("gables", material("#e0dbd0", 0.9), uvs=False))
    L.append("  " + box("ridge", (2 * roof["ridge_half"] + 0.3, 0.4, 0.45), (0, 0, roof["ridge_z"] + 0.12), RIDGE))
    L.append("}")
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- landscape
LAND_W, LAND_N, LAND_CY = 2400.0, 160, 250.0


def _vnoise(x, y, seed):
    """Smooth value noise in [-1, 1] (integer lattice hash, bicubic-ish fade)."""
    def h(i, j):
        n = (i * 374761393 + j * 668265263 + seed * 144269504) & 0xFFFFFFFF
        n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
        return ((n ^ (n >> 16)) & 0xFFFF) / 32767.5 - 1.0
    i, j = math.floor(x), math.floor(y)
    fx, fy = x - i, y - j
    ux, uy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b, c, d = h(i, j), h(i + 1, j), h(i, j + 1), h(i + 1, j + 1)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy


def terrain_h(x, y):
    """Hills around the monastery: flat inside the compound, a ridge rising behind it to the north."""
    dx = max(abs(x) - 110, 0.0)
    dn = max(y - 120, 0.0)
    ds = max(-110 - y, 0.0)
    dist = math.hypot(dx, max(dn, ds))
    rise = 0.34 * dn * math.exp(-dn / 900) + 0.16 * dx + 0.05 * ds
    n = 0.0
    amp, f = 1.0, 1 / 260
    for o in range(5):
        n += amp * _vnoise(x * f, y * f, 11 + o)
        amp *= 0.5
        f *= 2
    ramp = min(1.0, dist / 140)
    ramp = ramp * ramp * (3 - 2 * ramp)
    return ramp * (rise + 45 * (n + 0.35) + 25 * ramp)


def gen_landscape():
    """Scene frame: the valley floor and forested hills, and the trees around the courtyard."""
    rnd = random.Random(23)
    n = LAND_N
    cell = LAND_W / n
    heights = []
    for j in range(n + 1):
        y = LAND_CY - LAND_W / 2 + j * cell
        for i in range(n + 1):
            x = -LAND_W / 2 + i * cell
            heights.append(max(-0.2, terrain_h(x, y)) - 0.06)
    L = ["// Generated by gen_scene.py: valley floor, forested hills rising behind the monastery, and",
         "// instanced trees (broadleaf crowns and conifers) on them and around the courtyard.",
         "Group {", "  id: root",
         '  Texture { id: forestTex; source: "assets/meadow.png" }',
         '  Texture { id: leafTex; source: "assets/foliage.png" }',
         f"  HeightField {{ id: hills; width: {num(LAND_W)}; depth: {num(LAND_W)}; columns: {n}; rows: {n}; "
         f"position: [0, {num(LAND_CY)}, 0]; heights: [" + ",".join(f"{h:.1f}".rstrip('0').rstrip('.') for h in heights) + "]; "
         f"PrincipledMaterial {{ baseColor: \"#ffffff\"; roughness: 0.95; baseColorMap: forestTex; uvScale: [120, 120] }} }}"]
    crowns, cscale, conifers, kscale = [], [], [], []
    # forest on the slopes
    tries = 0
    while len(crowns) + len(conifers) < 5500 and tries < 120000:
        tries += 1
        x = rnd.uniform(-1050, 1050)
        y = rnd.uniform(LAND_CY - 1050, LAND_CY + 1050)
        if -140 < x < 140 and -130 < y < 130:
            continue
        h = terrain_h(x, y)
        if rnd.random() > min(1.0, 0.2 + h / 50) * (1.0 if math.hypot(x, y - 150) < 750 else 0.35):
            continue
        if rnd.random() < 0.3:
            k = rnd.uniform(1.0, 1.6)
            conifers.append((x, y, h - 0.5))
            kscale.append((k, k, k * rnd.uniform(0.9, 1.3)))
        else:
            r = rnd.uniform(5, 9)
            crowns.append((x, y, h + r * 0.55))
            cscale.append((r, r * rnd.uniform(0.85, 1.1), r * rnd.uniform(0.65, 0.85)))
    # big camphor trees framing the courtyard: a lumpy crown mesh on a trunk, one instance each
    big, bscale, byaw = [], [], []
    for x, y in ((-38, 8), (38, 6), (-40, 62), (40, 60), (-12, 64), (14, 66)):
        big.append((x, y, TERRACE_Z - 0.05))
        k = rnd.uniform(0.9, 1.1)
        bscale.append((k, k, k))
        byaw.append(rnd.uniform(0, 360))
    for _ in range(110):
        side = rnd.choice(("n", "n", "w", "e", "s"))
        if side == "n":
            x, y = rnd.uniform(-130, 130), rnd.uniform(80, 140)
        elif side == "s":
            x, y = (-1 if rnd.random() < 0.5 else 1) * rnd.uniform(48, 110), rnd.uniform(-90, -8)
        else:
            x, y = (-1 if side == "w" else 1) * rnd.uniform(52, 135), rnd.uniform(-5, 110)
        k = rnd.uniform(0.8, 1.35)
        big.append((x, y, -0.05))
        bscale.append((k, k * rnd.uniform(0.9, 1.1), k * rnd.uniform(0.9, 1.15)))
        byaw.append(rnd.uniform(0, 360))
    def far(p_): return math.hypot(p_[0], p_[1] - 60) > 420
    order = sorted(range(len(crowns)), key=lambda i: (far(crowns[i]), rnd.random()))
    crowns = [crowns[i] for i in order]
    cscale = [cscale[i] for i in order]
    n_near = sum(1 for p_ in crowns if not far(p_))
    greens = ("#5f7f3e", "#6f8c46", "#546f38")
    L.append(f"  Sphere {{ id: crownFarSrc; radius: 1; segments: 10; position: [0, 0, -40]; visible: false; "
             f"{material('#7f968a', 1.0, 'leafTex')} }}")
    L.append(f"  Lathe {{ id: coniferFarSrc; profile: {vlist([(0.4, 0, 0), (0.4, 0, 1.5), (3.4, 0, 2.2), (2.2, 0, 6), (1.2, 0, 10), (0.05, 0, 13)])}; "
             f"segments: 8; position: [0, 0, -40]; visible: false; {material('#72897c', 1.0, 'leafTex')} }}")
    for gi, g in enumerate(greens):
        L.append(f"  Sphere {{ id: crownSrc{gi}; radius: 1; segments: 14; position: [0, 0, -40]; visible: false; "
                 f"{material(g, 0.9, 'leafTex')} }}")
    L.append(f"  Lathe {{ id: coniferSrc; profile: {vlist([(0.4, 0, 0), (0.4, 0, 1.5), (3.4, 0, 2.2), (2.2, 0, 6), (1.2, 0, 10), (0.05, 0, 13)])}; "
             f"segments: 10; position: [0, 0, -40]; visible: false; {material('#4d6a3a', 0.9, 'leafTex')} }}")
    # near crowns cycle through three greens; batches past the haze line use the far material
    nb = (len(crowns) + 511) // 512
    for b_ in range(nb):
        src = f"crownSrc{b_ % 3}" if b_ * 512 < n_near else "crownFarSrc"
        L.append(f"  Prefab {{ id: crownPf{b_}; source: {src} }}")
    L.append("  Prefab { id: coniferPf; source: coniferSrc }")
    crown, trunk = MeshBuilder(), MeshBuilder()
    r2 = random.Random(5)
    trunk.lathe([(0.55, 0), (0.42, 0.8), (0.36, 3.5), (0.3, 6.5), (0.12, 8.5), (0.01, 9)], (0, 0, 0), 10)
    for a_, b_ in (((0, 0, 4), (2.6, 1.0, 7.5)), ((0, 0, 4.5), (-2.4, -1.3, 7.8)), ((0, 0, 5), (0.6, -2.4, 8.4))):
        trunk.bar(a_, b_, 0.3, 0.3)
    lumps = [(0, 0, 10.5, 4.2)] + [(4.2 * math.cos(t) * r2.uniform(0.7, 1), 3.6 * math.sin(t) * r2.uniform(0.7, 1),
                                    r2.uniform(7.5, 11.5), r2.uniform(2.3, 3.2)) for t in [i * 2.4 for i in range(11)]]
    for cx, cy, cz, r in lumps:
        crown.lathe([(0.01, -0.8 * r), (0.6 * r, -0.62 * r), (0.92 * r, -0.2 * r), (0.95 * r, 0.15 * r), (0.7 * r, 0.6 * r),
                     (0.3 * r, 0.9 * r), (0.01, 0.95 * r)], (cx, cy, cz), 14)
    L.append("  " + crown.ssdl("bigCrownSrc", material("#6b8a46", 0.9, "leafTex"), shading="smooth", visible=False,
                               extra="position: [0, 0, -40]"))
    L.append("  " + trunk.ssdl("bigTrunkSrc", material("#4a3b2e", 0.95), shading="smooth", uvs=False, visible=False,
                               extra="position: [0, 0, -40]"))
    L.append("  Prefab { id: bigCrownPf; source: bigCrownSrc }")
    L.append("  Prefab { id: bigTrunkPf; source: bigTrunkSrc }")
    L.append(f"  Instances {{ id: bigCrowns; prefab: bigCrownPf; positions: {vlist(big)}; rotations: {vlist([(0, 0, a_) for a_ in byaw])}; scales: {vlist(bscale)} }}")
    L.append(f"  Instances {{ id: bigTrunks; prefab: bigTrunkPf; positions: {vlist(big)}; rotations: {vlist([(0, 0, a_) for a_ in byaw])}; scales: {vlist(bscale)} }}")

    def fmt(pts, d=1): return "[" + ",".join("[" + ",".join(f"{c:.{d}f}".rstrip("0").rstrip(".") for c in p_) + "]" for p_ in pts) + "]"
    for k in range(0, len(crowns), 512):
        L.append(f"  Instances {{ id: crowns{k // 512}; prefab: crownPf{k // 512}; positions: {fmt(crowns[k:k + 512])}; "
                 f"scales: {fmt(cscale[k:k + 512], 2)} }}")
    conifers_k = sorted(zip(conifers, kscale), key=lambda c: far(c[0]))
    conifers = [c[0] for c in conifers_k]
    kscale = [c[1] for c in conifers_k]
    k_near = sum(1 for p_ in conifers if not far(p_))
    for b_ in range(1, (len(conifers) + 511) // 512):
        L.append(f"  Prefab {{ id: coniferPf{b_}; source: {'coniferSrc' if b_ * 512 < k_near else 'coniferFarSrc'} }}")
    for k in range(0, len(conifers), 512):
        L.append(f"  Instances {{ id: conifers{k // 512}; prefab: coniferPf{'' if k == 0 else k // 512}; positions: {fmt(conifers[k:k + 512])}; "
                 f"scales: {fmt(kscale[k:k + 512], 2)} }}")
    L.append("}")
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- camera shots
# name: (position, look-at point or (heading, pitch), fov). The page carries the same table (shots.js).
SHOTS = {
    "photo": ((0, -23, 1.6), (0, 12), 64),
    "hall": ((-6, 14, 4), (0, 27, 7.5), 60),
    "plaque": ((5, 18.5, 4.2), (0, 28.2, 12.4), 48),
    "eave": ((7, 17.5, 10.2), (14.5, 27, 12.6), 56),
    "rail": ((-13.5, -8.5, 2.2), (-9.5, -1.5, 1.2), 60),
    "east": ((8, 4, 3.5), (22, 17, 5), 60),
    "west": ((-15, 16, 4.2), (-28, 34, 5), 58),
    "aerial": ((-70, -60, 45), (0, 30, 6), 55),
}
SHOT_LABELS = {"photo": "照片机位", "hall": "殿前格扇", "plaque": "匾额", "eave": "飞檐斗拱", "rail": "汉白玉栏",
               "east": "东配楼", "west": "西配殿", "aerial": "鸟瞰全景"}


def shot_pose(name):
    pos, aim, fov = SHOTS[name]
    if len(aim) == 2:
        return pos, aim[0], aim[1], fov
    d = sub(aim, pos)
    heading = math.degrees(math.atan2(d[0], d[1])) % 360
    pitch = math.degrees(math.atan2(d[2], math.hypot(d[0], d[1])))
    return pos, heading, pitch, fov


def gen_scene():
    T = TERRACE_Z
    cam = shot_pose(os.environ.get("SSW_VIEW", "photo"))
    return f"""// DaxiongHall0924 — 重檐庑殿大雄宝殿与前广场，依据一张正面照片复刻（宁波，晴，上午）。
// Generated by gen_scene.py; edit the generator, not this file.
Scene {{
  id: main
  // The page's time slider writes these; Environment solves the sun (timeScale 0 stops the clock).
  property real timeOfDay: 9.5
  property string sceneDateTime: "2026-09-22T09:30:00+08:00"
  // A full moon (moonIntensity) is the night's background light; no exposure settings, so eye adaptation stays off.
  Environment {{ id: sky; dateTime: main.sceneDateTime; timeScale: 0; latitude: 29.87; longitude: 121.55; starsIntensity: 0.35; moonEnabled: true; moonPhaseOverride: 0.5; moonIntensity: 4; moonColor: "#b8c8ff" }}
  SkyAtmosphere {{ id: atmosphere }}
  DirectionalLight {{ id: sun; atmosphereSunLight: true; castShadows: true; lightColor: "#fff0dc" }}
  SkyLight {{ id: skyFill; intensity: 1.0; lowerHemisphereIsBlack: false; lowerHemisphereColor: "#8a8272" }}
  // Height fog with a warm lobe toward the sun. The Environment's weather owns the fog density on this
  // build, so distant forest also gets a paler, bluer material in Landscape for aerial perspective.
  ExponentialHeightFog {{ id: haze; fogDensity: 0.035; fogHeightFalloff: 0.02; startDistance: 120; fogMaxOpacity: 0.85; directionalInscatteringColor: "#ffd2a0"; directionalInscatteringExponent: 6 }}
  // Film grade: filmic contrast, soft bloom, a gentle lens flare and vignette.
  PostProcessVolume {{ id: grade; enabled: true; unbound: true; settings.temperature: 6300; settings.filmSlope: 0.9; settings.filmToe: 0.58; settings.bloomIntensity: 0.4; settings.bloomThreshold: 1.1; settings.lensFlareIntensity: 0.02; settings.vignetteIntensity: 0.38; settings.ambientOcclusionIntensity: 1.0 }}

  // Camera pose lives in scene properties so the page can cut between shots and fly the tour.
  property real camX: {num(cam[0][0])}
  property real camY: {num(cam[0][1])}
  property real camZ: {num(cam[0][2])}
  property real camHeading: {num(cam[1])}
  property real camPitch: {num(cam[2])}
  property real camFov: {num(cam[3])}
  CameraView {{ id: cineView; position: [main.camX, main.camY, main.camZ]; heading: main.camHeading; pitch: main.camPitch; fov: main.camFov }}
  Camera {{ id: mainCamera; initialView: cineView }}

  Plane {{ id: ground; width: 6000; depth: 6000; position: [0, 0, -0.3]; {material('#3f4a30', 1.0)} }}
  Landscape {{ id: landscape }}
  Terrace {{ id: terrace }}
  Balustrades {{ id: balustrades }}
  MainHall {{ id: hall; position: [0, {num(HALL_Y)}, {num(T)}]; }}
  HallRoof {{ id: hallRoof; position: [0, {num(HALL_Y)}, {num(T)}] }}
  HallRolls {{ id: hallRolls; position: [0, {num(HALL_Y)}, {num(T)}] }}
  Texture {{ id: smokeTex; source: "assets/smoke.png" }}
{chr(10).join(night_lamps())}
  SideHall {{ id: westHall; position: [-34, 36, {num(T)}] }}
  GableHall {{ id: eastHall; position: [22.5, 19.5, {num(T)}] }}
  Corridor {{ id: westCorridor; position: [-21.5, 44, {num(T)}]; scale: [0.52, 1, 1] }}
  Corridor {{ id: eastCorridor; position: [22, 44, {num(T)}]; scale: [0.52, 1, 1] }}
  CloudTree {{ id: westTree; position: [-17.5, 12, {num(T)}]; scale: [1.15, 1.15, 0.96] }}
  CloudTree {{ id: eastTree; position: [13.5, 9.8, {num(T)}]; scale: [0.85, 0.85, 1.08] }}
  BonsaiPine {{ id: westPine; position: [-9.5, 21.5, {num(T)}] }}
  BonsaiPine {{ id: eastPine; position: [10, 21.5, {num(T)}]; rotation: {vec(qz(180))} }}
}}
"""


def _publish(path, data):
    """Replace a project file only when its bytes change, via a temp file and an atomic rename, so the preview
    server (which recompiles on change and serves assets by size + digest) never reads a half-written file."""
    try:
        with open(path, "rb") as fh:
            if fh.read() == data:
                return False
    except FileNotFoundError:
        pass
    tmp = os.path.join(os.path.dirname(path), "." + os.path.basename(path) + ".tmp")
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)
    return True


def main():
    global ASSETS
    import shutil
    import tempfile
    final_assets, ASSETS = ASSETS, tempfile.mkdtemp(prefix="daxiong-assets-")
    try:
        write_textures()
        os.makedirs(final_assets, exist_ok=True)
        for name in sorted(os.listdir(ASSETS)):
            with open(os.path.join(ASSETS, name), "rb") as fh:
                if _publish(os.path.join(final_assets, name), fh.read()):
                    print(f"assets/{name}: updated")
    finally:
        shutil.rmtree(ASSETS, ignore_errors=True)
        ASSETS = final_assets
    files = {
        "HallRoof.ssdl": gen_hall_roof(),
        "HallRolls.ssdl": gen_hall_rolls(),
        "MainHall.ssdl": gen_main_hall(),
        "Terrace.ssdl": gen_terrace(),
        "Balustrades.ssdl": gen_balustrades(),
        "CloudTree.ssdl": gen_cloud_tree(),
        "BonsaiPine.ssdl": gen_bonsai(),
        "SideHall.ssdl": gen_side_hall(),
        "GableHall.ssdl": gen_gable_hall(),
        "Corridor.ssdl": gen_corridor(),
        "Landscape.ssdl": gen_landscape(),
        "scene.ssdl": gen_scene(),
    }
    shots = {k: dict(zip(("pos", "heading", "pitch", "fov"), shot_pose(k)), label=SHOT_LABELS[k]) for k in SHOTS}
    files["cinema-shots.js"] = ("// Generated by gen_scene.py from SHOTS: the camera presets the page flies to.\n"
                                "window.CINEMA_SHOTS = " + __import__("json").dumps(shots, ensure_ascii=False, indent=1) + ";\n")
    for name, text in files.items():
        changed = _publish(os.path.join(HERE, name), text.encode("utf-8"))
        print(f"{name}: {len(text) // 1024} KB{'' if changed else ' (unchanged)'}")


if __name__ == "__main__":
    main()
