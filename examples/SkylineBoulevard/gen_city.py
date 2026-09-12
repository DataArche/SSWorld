#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SkylineBoulevard / gen_city.py
=================================================================
程序化生成 scene.ssdl（SSDL 0.3）：

  1. 环境：SkyAtmosphere + 太阳（atmosphereSunLight）+ 体积云 + 高度雾 + 后期
  2. 地面：草地基底 / 大道（双向 5 车道 + 中央隔离带）/ 人行道 / 路缘 / 护栏
  3. 建筑 Prefab 组件：Loft 环形序列（每层玻璃面 + 出挑楼板带 + 退台 + 扭转 + 收分）
  4. 配景 Prefab：行道树（Lathe）、路灯（Tube 杆挑臂 + Box 灯头）、
     车辆（Loft 车厢 + Box 驾驶室）、行人（Cylinder + Sphere）
  5. Instances 批量摆放（explicit 坐标，单批 = 1 个原生对象）

约定：Prefab 源节点一律 position [0,0,0] 且 visible:false，
      实例坐标即最终世界坐标（Loft/Lathe 环坐标里 z 已含离地高度）。
"""
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "scene.ssdl")
SEED = 20260912

# ---------------------------------------------------------------- 格式化
def n(x):
    if abs(x) < 5e-4:
        return "0"
    s = "%.3f" % x
    s = s.rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def v3(p):
    return "[%s, %s, %s]" % (n(p[0]), n(p[1]), n(p[2]))


def v2(p):
    return "[%s, %s]" % (n(p[0]), n(p[1]))


L = []
def w(s=""):
    L.append(s)


# ---------------------------------------------------------------- 几何工具
def ring(w_, d_, cx=0.0, cy=0.0, rot=0.0, z=0.0, ch=0.0):
    """逆时针（自上而下看）矩形环；ch>0 时切角成 8 边形。"""
    hw, hd = w_ * 0.5, d_ * 0.5
    if ch > 0.0:
        c = min(ch, hw * 0.6, hd * 0.6)
        pts = [(hw, -hd + c), (hw, hd - c), (hw - c, hd), (-hw + c, hd),
               (-hw, hd - c), (-hw, -hd + c), (-hw + c, -hd), (hw - c, -hd)]
    else:
        pts = [(hw, -hd), (hw, hd), (-hw, hd), (-hw, -hd)]
    a = math.radians(rot)
    ca, sa = math.cos(a), math.sin(a)
    return [(cx + x * ca - y * sa, cy + x * sa + y * ca, z) for (x, y) in pts]


def rings_from_spec(spec):
    return [ring(s["w"], s["d"], s.get("cx", 0.0), s.get("cy", 0.0),
                 s.get("rot", 0.0), s["z"], s.get("ch", 0.0)) for s in spec]


def emit_loft(nid, spec, palette, tex=None, uvscale=None, tint=None):
    col, met, rgh = palette
    w("  // ---- %s ----" % nid)
    w("  Loft {")
    w("    id: %s" % nid)
    w("    visible: false")
    w("    cap: true")
    w("    sections: [" + ", ".join("[" + ", ".join(v3(p) for p in r) + "]"
                                    for r in rings_from_spec(spec)) + "]")
    w("  }")
    if tex:
        w("  PrincipledMaterial {")
        w("    target: %s" % nid)
        w('    baseColor: "%s"' % (tint or "#ffffff"))
        w("    baseColorMap: %s" % tex)
        w("    metallicRoughnessMap: %s_mr" % tex)
        w("    uvScale: [%d, %d]" % uvscale)
        w("    metalness: 1.0")
        w("    roughness: 1.0")
        w("  }")
    else:
        w('  PrincipledMaterial { target: %s; baseColor: "%s"; metalness: %s; roughness: %s }'
          % (nid, col, n(met), n(rgh)))
    w()


def emit_geom(node_text, nid, palette):
    col, met, rgh = palette
    w("  // ---- %s ----" % nid)
    w("  " + node_text)
    w('  PrincipledMaterial { target: %s; baseColor: "%s"; metalness: %s; roughness: %s }'
      % (nid, col, n(met), n(rgh)))
    w()


def emit_instances(nid, prefab, positions):
    """一批 positions 最多 256 个，超出自动分块（每块仍只占 1 个原生对象）。"""
    if len(positions) < 2:
        return
    chunks = [positions[i:i + 250] for i in range(0, len(positions), 250)]
    for ci, ch in enumerate(chunks):
        if len(ch) < 2:
            ch = chunks[ci - 1][-1:] + ch if ci else ch
        if len(ch) < 2:
            return
        w("  Instances {")
        w("    id: %s%s" % (nid, "" if len(chunks) == 1 else "_%d" % (ci + 1)))
        w("    prefab: %s" % prefab)
        w('    placement: "explicit"')
        w("    positions: [" + ", ".join(v3(p) for p in ch) + "]")
        w("  }")
    w()


# ---------------------------------------------------------------- 材质色板
PAL = {
    # 名称           基色        金属度 粗糙度
    "glassBlue":  ("#7c93a8", 0.72, 0.14),
    "glassDark":  ("#46586a", 0.80, 0.11),
    "glassTeal":  ("#79a8ab", 0.68, 0.16),
    "glassPale":  ("#a6b9c6", 0.58, 0.20),
    "glassNavy":  ("#3d5878", 0.76, 0.13),
    "panelWhite": ("#e4e2da", 0.06, 0.50),
    "panelCool":  ("#cfd5d8", 0.10, 0.44),
    "panelWarm":  ("#d3c8b1", 0.04, 0.62),
    "stoneTan":   ("#c2b394", 0.02, 0.74),
    "stoneGrey":  ("#a8a59d", 0.03, 0.70),
    "brickRed":   ("#a75a45", 0.02, 0.68),
    "paintPink":  ("#c98ea4", 0.02, 0.56),
    "paintBlue":  ("#4a6b91", 0.05, 0.54),
    "concrete":   ("#b8b4ab", 0.03, 0.66),
}

# 色板 → 程序化幕墙贴图（gen_tex.py 产出）+ 染色（baseColor 与贴图相乘）
TEX_STYLES = ("glassblue", "glassdark", "glassteal", "panel", "stone")
PAL2TEX = {
    "glassBlue": "glassblue", "glassPale": "glassblue", "paintBlue": "glassblue",
    "glassDark": "glassdark", "glassNavy": "glassdark",
    "glassTeal": "glassteal",
    "panelWhite": "panel", "panelCool": "panel", "panelWarm": "panel",
    "paintPink": "panel",
    "stoneTan": "stone", "stoneGrey": "stone", "concrete": "stone",
    "brickRed": "stone",
}
PAL2TINT = {
    "glassBlue": "#ffffff", "glassPale": "#ffffff", "glassDark": "#ffffff",
    "glassNavy": "#cfe0ff", "glassTeal": "#dcf6f4",
    "panelWhite": "#ffffff", "panelCool": "#f2f6fa", "panelWarm": "#ffe0b4",
    "paintPink": "#ffc2d6", "paintBlue": "#cfe0ff",
    "stoneTan": "#ffdcae", "stoneGrey": "#f0f0ee", "concrete": "#f2f0ea",
    "brickRed": "#ffb49a",
}

# ---------------------------------------------------------------- 建筑变体
class Bld(object):
    """bands = 楼层带数量（每带含 3~4 环，环总数须 ≤128）；bh = 带高 m。"""

    def __init__(self, key, style, w_, d_, bands, bh, pal, rot=0.0, out=0.5,
                 band=0.55, taper=0.0, twist=0.0, setbacks=(), ch=0.0, par=1.1):
        self.key, self.style = key, style
        self.w, self.d, self.floors, self.fh = w_, d_, bands, bh
        self.pal, self.rot, self.out, self.band = pal, rot, out, band
        self.taper, self.twist, self.setbacks = taper, twist, setbacks
        self.ch, self.par = ch, par
        self.h = bands * bh
        # 朝向 Y 的占地跨度（含小角度旋转的外接近似）
        a = math.radians(abs(rot))
        self.span = abs(d_ * math.cos(a)) + abs(w_ * math.sin(a))

    def spec(self):
        s = []
        z = 0.0
        for k in range(self.floors):
            t = k / max(1, self.floors - 1)
            sc = 1.0
            for (tt, ss) in self.setbacks:
                if t >= tt:
                    sc = ss
            sc *= (1.0 - self.taper * t)
            r = self.rot + self.twist * t
            ww, dd = self.w * sc, self.d * sc
            z0, z1 = z, z + self.fh
            if self.style == "band":
                s.append(dict(z=z0, w=ww, d=dd, rot=r, ch=self.ch))
                s.append(dict(z=z1 - self.band, w=ww, d=dd, rot=r, ch=self.ch))
                s.append(dict(z=z1 - self.band, w=ww + 2 * self.out, d=dd + 2 * self.out,
                              rot=r, ch=self.ch))
                s.append(dict(z=z1, w=ww + 2 * self.out, d=dd + 2 * self.out,
                              rot=r, ch=self.ch))
            elif self.style == "strip":
                s.append(dict(z=z0, w=ww, d=dd, rot=r, ch=self.ch))
                s.append(dict(z=z0 + self.fh * 0.34, w=ww - 2 * self.out, d=dd - 2 * self.out,
                              rot=r, ch=self.ch))
                s.append(dict(z=z1, w=ww - 2 * self.out, d=dd - 2 * self.out,
                              rot=r, ch=self.ch))
            z = z1
        last = s[-1]
        s.append(dict(z=last["z"] + self.par, w=last["w"], d=last["d"],
                      rot=last["rot"], ch=self.ch))
        return s


# out/band 是「出挑」米数；bh 为楼层带高（≈2 层），ring 数 = bands*(3 或 4)+1 ≤ 128
VARIANTS = [
    # --- 沿街裙楼 / 低层商业（屋顶接近 26m 视平线，对照参考图近景）---
    Bld("bPodiumW1", "band", 30, 24, 6, 4.3, "panelWhite", out=0.42, band=0.55),
    Bld("bPodiumW2", "band", 26, 22, 5, 4.4, "panelCool", out=0.34, band=0.48, rot=2.5),
    Bld("bPodiumW3", "strip", 24, 26, 7, 4.0, "glassBlue", out=0.30, rot=-3.0),
    Bld("bPodiumE1", "band", 32, 26, 6, 4.4, "panelWhite", out=0.46, band=0.58, rot=1.5),
    Bld("bPodiumE2", "strip", 22, 24, 8, 3.9, "glassPale", out=0.28, rot=-2.0),
    Bld("bPodiumE3", "band", 28, 20, 5, 4.6, "stoneTan", out=0.38, band=0.50, rot=3.5),
    Bld("bShop1", "strip", 20, 18, 3, 4.6, "concrete", out=0.34, rot=-4.0),
    Bld("bShop2", "band", 18, 16, 4, 4.4, "panelWarm", out=0.36, band=0.46, rot=5.0),
    Bld("bShop3", "strip", 16, 20, 3, 4.8, "stoneGrey", out=0.30),
    # --- 中层（40~85m）---
    Bld("bMid1", "band", 30, 30, 9, 5.0, "glassBlue", out=0.30, band=0.40),
    Bld("bMid2", "strip", 26, 34, 11, 4.6, "glassTeal", rot=6.0, out=0.26),
    Bld("bMid3", "band", 34, 26, 8, 5.2, "panelWhite", rot=-4.0, out=0.34, band=0.44, ch=1.4),
    Bld("bMid4", "strip", 24, 28, 13, 4.4, "glassDark", out=0.24),
    Bld("bMid5", "band", 28, 32, 8, 5.2, "stoneTan", rot=8.0, out=0.30, band=0.40),
    Bld("bMid6", "strip", 30, 24, 12, 4.6, "panelWhite", rot=-7.0, out=0.25),
    Bld("bMid7", "band", 22, 30, 9, 5.0, "brickRed", rot=3.0, out=0.28, band=0.38),
    Bld("bMid8", "strip", 32, 28, 12, 4.8, "paintPink", rot=-3.0, out=0.24),
    Bld("bMid9", "band", 26, 26, 7, 5.4, "concrete", rot=5.0, out=0.32, band=0.42),
    Bld("bMid10", "strip", 28, 30, 10, 5.0, "glassNavy", out=0.26),
    # --- 高层（85~140m）---
    Bld("bHigh1", "strip", 34, 34, 16, 5.6, "glassBlue", out=0.26, taper=0.10),
    Bld("bHigh2", "band", 30, 30, 13, 6.0, "stoneTan", out=0.30, band=0.40),
    Bld("bHigh3", "strip", 28, 36, 17, 5.6, "glassDark", out=0.24, twist=9.0),
    Bld("bHigh4", "band", 36, 30, 12, 6.2, "stoneTan", out=0.32, band=0.44,
        setbacks=((0.45, 0.78), (0.75, 0.58)), ch=1.6),
    Bld("bHigh5", "strip", 32, 32, 17, 5.8, "glassTeal", out=0.25, taper=0.16),
    Bld("bHigh6", "band", 30, 34, 14, 5.8, "panelWarm", out=0.28, band=0.38),
    Bld("bHigh7", "strip", 26, 30, 18, 5.6, "glassPale", out=0.24, twist=-7.0),
    Bld("bHigh8", "band", 34, 28, 12, 6.4, "brickRed", out=0.30, band=0.42,
        setbacks=((0.55, 0.72),)),
    Bld("bHigh9", "strip", 30, 30, 15, 5.8, "panelWhite", out=0.25, taper=0.08),
    # --- 超高层地标（140~210m）---
    Bld("bLand1", "strip", 38, 38, 22, 6.4, "glassBlue", out=0.28, taper=0.22),
    Bld("bLand2", "band", 34, 34, 19, 6.8, "glassDark", out=0.32, band=0.42,
        setbacks=((0.40, 0.80), (0.70, 0.55))),
    Bld("bLand3", "strip", 36, 32, 24, 6.2, "glassPale", out=0.26, twist=14.0),
    Bld("bLand4", "band", 40, 36, 17, 7.0, "stoneTan", out=0.34, band=0.46, ch=2.0),
    # --- 补充：浅色板楼 / 石材楼，平衡玻璃蓝的比例 ---
    Bld("bMid11", "band", 30, 26, 10, 5.2, "panelWhite", out=0.30, band=0.40, rot=-5.0),
    Bld("bMid12", "band", 26, 30, 9, 5.4, "stoneTan", out=0.28, band=0.38, rot=4.0),
    Bld("bMid13", "band", 32, 24, 11, 5.0, "panelWarm", out=0.30, band=0.40, rot=-2.0),
    Bld("bHigh10", "band", 30, 30, 14, 6.0, "panelWhite", out=0.30, band=0.42),
    Bld("bHigh11", "band", 34, 28, 13, 6.2, "stoneGrey", out=0.28, band=0.40, rot=6.0),
    Bld("bHigh12", "strip", 28, 32, 16, 5.8, "glassTeal", out=0.24, taper=0.12),
    Bld("bLand5", "band", 36, 34, 16, 7.2, "concrete", out=0.32, band=0.44, ch=1.8),
    # --- 天际线制高点（190~235m）---
    Bld("bTower1", "strip", 42, 42, 30, 7.2, "glassBlue", out=0.28, taper=0.26),
    Bld("bTower2", "band", 38, 38, 27, 7.6, "glassDark", out=0.32, band=0.44,
        setbacks=((0.35, 0.84), (0.62, 0.62), (0.85, 0.40))),
    Bld("bTower3", "band", 40, 36, 26, 7.8, "stoneTan", out=0.34, band=0.46, ch=2.2),
    Bld("bTower4", "strip", 36, 40, 29, 7.4, "glassTeal", out=0.26, twist=18.0),
    Bld("bTower5", "band", 44, 40, 25, 8.0, "panelWhite", out=0.30, band=0.42, taper=0.12),
]

# ---------------------------------------------------------------- 场景装配
rng = random.Random(SEED)
groups = {b.key: [] for b in VARIANTS}
BY = {b.key: b for b in VARIANTS}


# 西侧公园山体（HeightField）：先定范围，建筑与树木都让开
HILL_CX, HILL_CY = -208.0, 312.0
HILL_RX, HILL_RY = 132.0, 196.0


def in_park(x, y, k=1.0):
    return ((x - HILL_CX) / (HILL_RX * k)) ** 2 + ((y - HILL_CY) / (HILL_RY * k)) ** 2 < 1.0


def put(key, x, y):
    groups[key].append((x, y, 0.0))


def row(pool, xc, y0, y1, gap_lo, gap_hi, xjit, rng_):
    y = y0 + rng_.uniform(0, 18)
    while True:
        y += rng_.uniform(gap_lo, gap_hi)
        b = rng_.choice(pool)
        if y + b.span > y1:
            break
        x = xc + rng_.uniform(-xjit, xjit)
        if in_park(x, y + b.span * 0.5, 1.12) or near_cross(y, b.span):
            y += b.span * rng_.uniform(0.5, 1.0)
            continue
        put(b.key, x, y + b.span * 0.5)
        y += b.span


POD = [BY[k] for k in ("bPodiumW1", "bPodiumW1", "bPodiumW2", "bPodiumW3", "bPodiumE1",
                       "bPodiumE1", "bPodiumE2", "bPodiumE3", "bShop1", "bShop2", "bShop3")]
LOW = [BY[k] for k in ("bShop1", "bShop2", "bShop3", "bPodiumE3", "bPodiumW2",
                      "bPodiumE3", "bShop1")]
MID = [BY[k] for k in ("bMid1", "bMid2", "bMid3", "bMid3", "bMid4", "bMid5", "bMid6",
                       "bMid7", "bMid8", "bMid9", "bMid10", "bMid11", "bMid11", "bMid12",
                       "bMid13", "bMid12", "bMid7", "bMid5")]
HIGH = [BY[k] for k in ("bHigh1", "bHigh2", "bHigh3", "bHigh4", "bHigh5",
                        "bHigh6", "bHigh7", "bHigh8", "bHigh9", "bHigh10", "bHigh10",
                        "bHigh11", "bHigh11", "bHigh12", "bHigh4", "bHigh8")]
LAND = [BY[k] for k in ("bLand1", "bLand2", "bLand3", "bLand4", "bLand5",
                        "bTower1", "bTower2", "bTower3", "bTower4", "bTower5")]

# 大道走廊：y ∈ [-170, 1080]；交叉街每 130m 让出 22m 作为横向街道
CROSS = [(-170 + 130 * i) for i in range(11)]
def near_cross(y, span):
    return any(abs(y + span * 0.5 - c) < span * 0.5 + 11 for c in CROSS)

Y0, Y1 = -170.0, 1080.0

for sy in (-1, 1):
    # A 排：沿街裙楼，退红线留出草坪，间距拉开
    if sy < 0:
        row(LOW, sy * 58.0, Y0, 300, 16, 42, 3.0, rng)
        row(POD, sy * 58.0, 300, 1150, 12, 34, 3.5, rng)
    else:
        row(POD, sy * 58.0, Y0, 1150, 12, 34, 3.5, rng)
    # B 排：中层
    row(MID, sy * 100.0, Y0, 1250, 10, 24, 5.0, rng)
    # C 排：高层
    row(HIGH + MID, sy * 152.0, Y0, 1250, 10, 22, 7.0, rng)
    # D 排：高层/地标
    row(HIGH, sy * 218.0, Y0, 400, 14, 28, 10.0, rng)
    row(HIGH + LAND, sy * 218.0, 400, 1500, 14, 28, 10.0, rng)
    # E 排：远景天际线
    row(HIGH + LAND, sy * 302.0, -60, 1700, 20, 40, 16.0, rng)

# 北端 CBD 核心：更密、更高，填满画面中景天际线
for sy in (-1, 1):
    for k, xc in enumerate((60, 108, 164, 228, 300, 380)):
        pool = LAND + HIGH if k < 3 else HIGH + MID
        row(pool, sy * (xc + rng.uniform(-6, 6)), 700, 1780,
            6 + 4 * k, 14 + 6 * k, 5.0 + 2 * k, rng)

# 地标：参考图右侧近处的巨型玻璃塔 + 左侧红顶楼
groups["bLand1"].append((104, 470, 0.0))
groups["bLand3"].append((158, 640, 0.0))
groups["bLand2"].append((-126, 560, 0.0))
groups["bHigh4"].append((112, -34, 0.0))
groups["bHigh8"].append((-96, 96, 0.0))

ALL = [(k, v) for k, v in groups.items() if len(v) >= 2]
BLD_TOTAL = sum(len(v) for _, v in ALL)

# ---------------------------------------------------------------- 输出
w("// ============================================================")
w("//  SkylineBoulevard —— 程序化生成，请勿手改；改 gen_city.py 后重跑")
w("//  建筑 = Loft 程序化几何（楼层带 / 退台 / 扭转 / 收分），Instances 批量摆放")
w("// ============================================================")
w("Scene {")
w("  id: main")
w()
w("  // ---------------- 相机：26m 高视点，沿大道向北 ----------------")
w("  CameraView { id: heroView; position: [1.5, -96, 26]; heading: 0; pitch: -4.2; fov: 58 }")
w("  Camera { id: mainCamera; initialView: heroView }")
w()
w("  // ---------------- 大气 / 太阳 / 雾 ----------------")
w("  // 坑 1：太阳不要写 useTemperature/temperature —— 会污染大气太阳色，天空整片变橙")
w("  // 坑 2：SkyAtmosphere 的 rayleigh/mie/skyLuminanceFactor 只要写上任一就把天空染橙 —— 保持全默认")
w("  SkyAtmosphere { id: sky }")
w("  DirectionalLight {")
w("    id: sun")
w("    atmosphereSunLight: true")
w("    sunAzimuth: 196")
w("    sunElevation: 56")
w("    intensity: 1.55")
w('    lightColor: "#ffe8c0"')
w("    castShadows: true")
w("  }")
w("  SkyLight { id: skyFill; intensity: 0.48; lowerHemisphereColor: \"#6e7264\" }")
w("  ExponentialHeightFog {")
w("    id: haze")
w("    fogDensity: 0.00016")
w("    fogHeightFalloff: 0.01")
w("    startDistance: 500")
w("    fogMaxOpacity: 0.10")
w("    fogCutoffDistance: 30000")
w('    fogInscatteringColor: "#cfe2f4"')
w('    directionalInscatteringColor: "#e2edf8"')
w("    directionalInscatteringExponent: 6")
w("  }")
w("  PostProcessVolume {")
w("    id: post")
w("    unbound: true")
w("    settings.autoExposureBias: 0.28")
w("    settings.bloomThreshold: 1.15")
w("    settings.bloomIntensity: 0.35")
w("    settings.ambientOcclusionIntensity: 0.60")
w("    settings.ambientOcclusionPower: 1.7")
w("    settings.ambientOcclusionFadeDistance: 45")
w("    settings.toneCurveAmount: 1")
w("    settings.expandGamut: 1.0")
w("    settings.vignetteIntensity: 0.16")
w("  }")
w()

# ---------------- 地面 / 大道 ----------------
ROAD_Y, ROAD_LEN = 800.0, 1960.0
w("  // ---------------- 地表贴图（程序化，gen_tex.py 产出）----------------")
for k in ("leaf", "asphalt", "grass", "pavement"):
    w('  Texture { id: tex_%s; source: "assets/surf_%s.png" }' % (k, k))
w()
w("  // ---------------- 地面与大道 ----------------")
w('  Plane { id: terrain; width: 4200; depth: 4600; position: [0, 500, -0.06] }')
w('  PrincipledMaterial { target: terrain; baseColorMap: tex_grass; uvScale: [340, 380]; roughness: 0.95 }')
w('  Plane { id: lawnW; width: 700; depth: 3600; position: [-520, 420, -0.04] }')
w('  PrincipledMaterial { target: lawnW; baseColorMap: tex_grass; uvScale: [60, 320]; roughness: 0.95 }')
w('  Plane { id: lawnE; width: 700; depth: 3600; position: [520, 420, -0.04] }')
w('  PrincipledMaterial { target: lawnE; baseColorMap: tex_grass; uvScale: [60, 320]; roughness: 0.95 }')
# 街区铺装（灰）
w('  Box { id: plazaW; width: 140; depth: %s; height: 0.10; position: [-104, %s, 0.05] }'
  % (n(ROAD_LEN), n(ROAD_Y)))
w('  Box { id: plazaE; width: 140; depth: %s; height: 0.10; position: [104, %s, 0.05] }'
  % (n(ROAD_LEN), n(ROAD_Y)))
w('  PrincipledMaterial { target: plazaW; baseColorMap: tex_pavement; uvScale: [16, 140]; roughness: 0.82 }')
w('  PrincipledMaterial { target: plazaE; baseColorMap: tex_pavement; uvScale: [16, 140]; roughness: 0.82 }')
# 车行道
w('  Box { id: roadW; width: 17.5; depth: %s; height: 0.10; position: [-10.35, %s, 0.05] }'
  % (n(ROAD_LEN), n(ROAD_Y)))
w('  Box { id: roadE; width: 17.5; depth: %s; height: 0.10; position: [10.35, %s, 0.05] }'
  % (n(ROAD_LEN), n(ROAD_Y)))
w('  PrincipledMaterial { target: roadW; baseColorMap: tex_asphalt; uvScale: [4, 250]; roughness: 0.88 }')
w('  PrincipledMaterial { target: roadE; baseColorMap: tex_asphalt; uvScale: [4, 250]; roughness: 0.88 }')
# 中央隔离带 + 缘石
w('  Box { id: median; width: 3.2; depth: %s; height: 0.42; position: [0, %s, 0.21]; color: "#9d9a91" }'
  % (n(ROAD_LEN), n(ROAD_Y)))
w('  Box { id: medianCap; width: 2.5; depth: %s; height: 0.10; position: [0, %s, 0.47]; color: "#6f7a52" }'
  % (n(ROAD_LEN), n(ROAD_Y)))
# 人行道（含路缘）
for sx, tag in ((-1, "W"), (1, "E")):
    x0 = sx * 22.5
    w('  Box { id: walk%s; width: 6.8; depth: %s; height: 0.32; position: [%s, %s, 0.16] }'
      % (tag, n(ROAD_LEN), n(x0), n(ROAD_Y)))
    w('  PrincipledMaterial { target: walk%s; baseColorMap: tex_pavement; uvScale: [1, 150]; roughness: 0.85 }' % tag)
    w('  Box { id: curb%s; width: 0.34; depth: %s; height: 0.36; position: [%s, %s, 0.18]; color: "#d2cec2" }'
      % (tag, n(ROAD_LEN), n(sx * 19.25), n(ROAD_Y)))
    # 护栏：上横杆 + 中横杆
    w('  Box { id: rail%s; width: 0.14; depth: %s; height: 0.12; position: [%s, %s, 1.10]; color: "#c9c7be" }'
      % (tag, n(ROAD_LEN), n(sx * 19.5), n(ROAD_Y)))
    w('  Box { id: rail%s2; width: 0.10; depth: %s; height: 0.10; position: [%s, %s, 0.72]; color: "#bcbab1" }'
      % (tag, n(ROAD_LEN), n(sx * 19.5), n(ROAD_Y)))
    w('  PrincipledMaterial { target: rail%s; baseColor: "#cdcbc2"; metalness: 0.55; roughness: 0.38 }' % tag)
    w('  PrincipledMaterial { target: rail%s2; baseColor: "#c2c0b7"; metalness: 0.55; roughness: 0.40 }' % tag)
w()

# ---------------- 建筑 ----------------
w("  // ============================================================")
w("  //  建筑 Prefab 源：Loft 程序化几何（visible:false，仅作实例源）")
w("  //  立面 = 程序化幕墙贴图（assets/facade_*.png，gen_tex.py 产出）")
w("  //  uvScale.u = 环向窗格数，uvScale.v = 楼层带数（与 sections 环数严格对齐）")
w("  // ============================================================")
for st in TEX_STYLES:
    for kind in ("band", "strip"):
        w('  Texture { id: tex_%s_%s; source: "assets/facade_%s_%s.png" }'
          % (kind, st, kind, st))
        w('  Texture { id: tex_%s_%s_mr; source: "assets/facade_%s_%s_mr.png" }'
          % (kind, st, kind, st))
w()
for b in VARIANTS:
    st = PAL2TEX[b.pal]
    per = 2.0 * (b.w + b.d)
    uvs = (max(4, int(round(per / 3.2))), b.floors)
    emit_loft("bld_" + b.key, b.spec(), PAL[b.pal],
              tex="tex_%s_%s" % (b.style, st), uvscale=uvs, tint=PAL2TINT[b.pal])

w("  // ============================================================")
w("  //  建筑实例：每个变体一批 = 1 个原生对象")
w("  // ============================================================")
for b in VARIANTS:
    w('  Prefab { id: pf_%s; source: bld_%s }' % (b.key, b.key))
w()
for b in VARIANTS:
    emit_instances("inst_" + b.key, "pf_" + b.key, groups[b.key])
w()

# ---------------- 配景源 ----------------
w("  // ============================================================")
w("  //  配景 Prefab 源")
w("  // ============================================================")

# 阔叶行道树：Lathe 一次成型（树干 + 树冠）；端点留极小半径，避免退化环
tree_broad = [[0.08, 0, 0], [0.40, 0, 0.20], [0.34, 0, 2.05], [0.80, 0, 2.45],
              [1.85, 0, 3.05], [2.55, 0, 4.30], [2.70, 0, 5.40], [2.15, 0, 6.35],
              [1.10, 0, 6.90], [0.08, 0, 7.20]]
w("  Lathe { id: treeBroad; visible: false; segments: 12; closed: false;")
w("    profile: [" + ", ".join(v3(p) for p in tree_broad) + "] }")
w("  PrincipledMaterial { target: treeBroad; baseColorMap: tex_leaf; uvScale: [4, 3]; roughness: 0.92 }")
w()
tree_pine = [[0.09, 0, 0], [0.34, 0, 0.28], [0.28, 0, 1.30], [1.55, 0, 2.15],
             [0.80, 0, 3.60], [1.35, 0, 4.45], [0.62, 0, 6.30], [1.00, 0, 7.10],
             [0.42, 0, 8.90], [0.09, 0, 10.10]]
w("  Lathe { id: treePine; visible: false; segments: 9; closed: false;")
w("    profile: [" + ", ".join(v3(p) for p in tree_pine) + "] }")
w("  PrincipledMaterial { target: treePine; baseColorMap: tex_leaf; uvScale: [4, 4]; baseColor: \"#b8ccb0\"; roughness: 0.94 }")
w()

# 路灯：Tube 一体成型（立杆 + 上挑灯臂），左右各一反
# 立杆带 6cm 微倾，避免完全竖直的切向让平行传输标架退化
def lamp_path(sx):
    pts = [(0.065, 0.0, 0.0), (0.032, 0.0, 4.6), (0.0, 0.0, 9.15)]
    for i in range(1, 8):
        t = i / 7.0
        pts.append((sx * 5.75 * t, 0.0, 9.15 + 1.45 * math.sin(math.radians(90.0 * t))))
    return pts

for sx, tag in ((-1, "W"), (1, "E")):
    w("  Tube { id: lampArm%s; visible: false; segments: 7; closed: false; radius: 0.135;"
      % tag)
    w("    path: [" + ", ".join(v3(p) for p in lamp_path(sx)) + "] }")
    w('  PrincipledMaterial { target: lampArm%s; baseColor: "#33383d"; metalness: 0.72; roughness: 0.34 }' % tag)
    w()

w('  Box { id: lampHead; visible: false; width: 1.45; depth: 0.52; height: 0.30; position: [0, 0, 0]; color: "#d9d8d0" }')
w('  PrincipledMaterial { target: lampHead; baseColor: "#d9d8d0"; metalness: 0.45; roughness: 0.32 }')
w()

# 车辆：Loft 车厢 + Box 驾驶室
truck = [dict(z=0.14, w=2.30, d=7.10), dict(z=0.62, w=2.48, d=7.45),
         dict(z=3.05, w=2.48, d=7.45), dict(z=3.32, w=2.28, d=7.25)]
VCAR = {"cy": "#2fb0c4", "or": "#dd6f34", "rd": "#c23f2c",
        "wt": "#e6e4dd", "li": "#a6c53c", "bl": "#3d78bd"}
for k in VCAR:
    emit_loft("vehBox_" + k, truck, (VCAR[k], 0.10, 0.42))
w('  Box { id: vehCab; visible: false; width: 2.30; depth: 2.05; height: 1.95; position: [0, 0, 0]; color: "#2c3740" }')
w('  PrincipledMaterial { target: vehCab; baseColor: "#2c3740"; metalness: 0.55; roughness: 0.22 }')
w()

# 行人
w('  Cylinder { id: pedBody; visible: false; radius: 0.26; height: 1.12; segments: 8; position: [0, 0, 0]; color: "#3b4250" }')
w('  PrincipledMaterial { target: pedBody; baseColor: "#3b4250"; metalness: 0; roughness: 0.75 }')
w('  Sphere { id: pedHead; visible: false; radius: 0.16; segments: 8; position: [0, 0, 0]; color: "#c99a72" }')
w('  PrincipledMaterial { target: pedHead; baseColor: "#c99a72"; metalness: 0; roughness: 0.68 }')
w()

# 车道虚线
w('  Box { id: dash; visible: false; width: 0.17; depth: 4.6; height: 0.03; position: [0, 0, 0]; color: "#e9e7de" }')
w('  PrincipledMaterial { target: dash; baseColor: "#e9e7de"; metalness: 0; roughness: 0.55 }')
w()
# 隔离带灌木
w('  Sphere { id: shrub; visible: false; radius: 1.0; segments: 8; position: [0, 0, 0]; color: "#4c6f38" }')
w('  PrincipledMaterial { target: shrub; baseColor: "#4c6f38"; metalness: 0; roughness: 0.9 }')
w()

# ---------------- 配景实例 ----------------
w("  // ============================================================")
w("  //  配景实例")
w("  // ============================================================")
w('  Prefab { id: pfTreeBroad; source: treeBroad }')
w('  Prefab { id: pfTreePine; source: treePine }')
w('  Prefab { id: pfLampW; source: lampArmW }')
w('  Prefab { id: pfLampE; source: lampArmE }')
w('  Prefab { id: pfLampHead; source: lampHead }')
w('  Prefab { id: pfVehCab; source: vehCab }')
w('  Prefab { id: pfPedBody; source: pedBody }')
w('  Prefab { id: pfPedHead; source: pedHead }')
w('  Prefab { id: pfDash; source: dash }')
w('  Prefab { id: pfShrub; source: shrub }')
for k in VCAR:
    w('  Prefab { id: pfVeh_%s; source: vehBox_%s }' % (k, k))
w()

trees_b, trees_p, cars, cabs = [], [], [], []
# 人行道行道树（外侧）
for sx in (-1, 1):
    y = -160.0
    while y < 1680:
        if not near_cross(y, 3.0):
            (trees_b if rng.random() < 0.62 else trees_p).append(
                (sx * 25.2 + rng.uniform(-0.5, 0.5), y + rng.uniform(-2.5, 2.5), 0.32))
        y += rng.uniform(15.0, 21.0)
# 绿化带（人行道与街区之间）
for sx in (-1, 1):
    y = -150.0
    while y < 1680:
        (trees_b if rng.random() < 0.5 else trees_p).append(
            (sx * 30.5 + rng.uniform(-1.6, 1.6), y + rng.uniform(-4, 4), 0.10))
        y += rng.uniform(20.0, 32.0)
# 街区内部 / 空地绿化
for _ in range(140):
    sx = rng.choice((-1, 1))
    x = sx * rng.uniform(38, 330)
    y = rng.uniform(-150, 1380)
    (trees_b if rng.random() < 0.6 else trees_p).append((x, y, 0.10))
# 西侧山体公园（椭圆内，随坡就势）
for _ in range(110):
    x = HILL_CX + rng.uniform(-HILL_RX * 0.95, HILL_RX * 0.95)
    y = HILL_CY + rng.uniform(-HILL_RY * 0.95, HILL_RY * 0.95)
    if in_park(x, y, 0.95):
        (trees_b if rng.random() < 0.42 else trees_p).append((x, y, 0.10))

# 路灯
lamp_w, lamp_e, lamp_h = [], [], []
y = -150.0
while y < 1680:
    lamp_w.append((-20.4, y, 0.32))
    lamp_e.append((20.4, y, 0.32))
    lamp_h.append((-20.4 - 5.85, y, 0.32 + 10.6))
    lamp_h.append((20.4 + 5.85, y, 0.32 + 10.6))
    y += 42.0

# 车辆：东侧（北向，远去）彩色厢式车队 + 西侧（南向）来车
veh_by_col = {k: [] for k in VCAR}
cab_pos = []
keys = list(VCAR.keys())
y = -46.0
i = 0
while y < 520:
    k = keys[i % len(keys)]
    x = rng.choice((3.35, 6.85, 6.85, 10.35))
    veh_by_col[k].append((x, y, 0.10))
    cab_pos.append((x, y + 4.72, 1.28))
    y += rng.uniform(15.0, 23.0)
    i += 1
for _ in range(16):
    y = rng.uniform(40, 900)
    x = rng.choice((-3.35, -6.85, -10.35, -13.85, -17.35))
    k = keys[rng.randrange(len(keys))]
    veh_by_col[k].append((x, y, 0.10))
    cab_pos.append((x, y - 4.72, 1.28))
for _ in range(14):
    y = rng.uniform(120, 980)
    x = rng.choice((10.35, 13.85, 17.35))
    k = keys[rng.randrange(len(keys))]
    veh_by_col[k].append((x, y, 0.10))
    cab_pos.append((x, y + 4.72, 1.28))

# 行人（近景人行道）
peds, heads = [], []
for _ in range(26):
    sx = rng.choice((-1, 1))
    x = sx * rng.uniform(20.6, 24.6)
    y = rng.uniform(-120, 300)
    peds.append((x, y, 0.32 + 0.56))
    heads.append((x, y, 0.32 + 1.40))

# 车道虚线
dashes = []
LANES = [5.1, 8.6, 12.1, 15.6]
y = -150.0
while y < 340:
    for lx in LANES:
        dashes.append((-lx, y, 0.11))
        dashes.append((lx, y, 0.11))
    y += 13.0

# 隔离带灌木
shrubs = []
y = -140.0
while y < 1680:
    shrubs.append((0.0, y, 0.52))
    y += 17.0

emit_instances("instTreeBroad", "pfTreeBroad", trees_b)
emit_instances("instTreePine", "pfTreePine", trees_p)
emit_instances("instLampW", "pfLampW", lamp_w)
emit_instances("instLampE", "pfLampE", lamp_e)
emit_instances("instLampHead", "pfLampHead", lamp_h)
for k in VCAR:
    emit_instances("instVeh_" + k, "pfVeh_" + k, veh_by_col[k])
emit_instances("instVehCab", "pfVehCab", cab_pos)
emit_instances("instPedBody", "pfPedBody", peds)
emit_instances("instPedHead", "pfPedHead", heads)
emit_instances("instDash", "pfDash", dashes)
emit_instances("instShrub", "pfShrub", shrubs)

# 西侧山体（HeightField 程序化地形）
HC, HR = 26, 26
NC, NR = HC + 1, HR + 1
HW, HD = HILL_RX * 2 + 80.0, HILL_RY * 2 + 80.0
heights = []
for j in range(NR):
    for i in range(NC):
        u = (i / HC) * 2 - 1
        v = (j / HR) * 2 - 1
        d = math.hypot(u, v)
        f = max(0.0, 1.0 - d)
        h = 34.0 * (f ** 1.9) * (1.0 + 0.30 * math.sin(u * 4.7 + 1.1) * math.cos(v * 3.9))
        heights.append(max(0.0, h))
w("  // ---------------- 西侧山体（HeightField 程序化地形）----------------")
w("  HeightField {")
w("    id: hill")
w("    width: %s" % n(HW))
w("    depth: %s" % n(HD))
w("    columns: %d" % HC)
w("    rows: %d" % HR)
w("    position: [%s, %s, -2.5]" % (n(HILL_CX), n(HILL_CY)))
w("    heights: [" + ", ".join(n(h) for h in heights) + "]")
w("  }")
w('  PrincipledMaterial { target: hill; baseColor: "#6f8549"; metalness: 0; roughness: 0.93 }')
w()
w("}")

with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(L) + "\n")

print("wrote %s  %.1f KB  lines=%d" % (OUT, os.path.getsize(OUT) / 1024.0, len(L)))
print("buildings=%d variants=%d" % (BLD_TOTAL, len(ALL)))
print("trees=%d lamps=%d veh=%d peds=%d dashes=%d shrubs=%d" % (
    len(trees_b) + len(trees_p), len(lamp_w) + len(lamp_e),
    sum(len(v) for v in veh_by_col.values()), len(peds), len(dashes), len(shrubs)))
