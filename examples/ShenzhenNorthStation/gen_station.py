#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ShenzhenNorthStation / gen_station.py
=================================================================
程序化生成深圳北站场景（SSDL 0.3）。

坐标系：右手 Z-up，X 东、Y 北、Z 上，单位米，原点在深圳北站主站房中心。

真实工程基准（可在 README.md 查到来源/推定标注）：
  岛式站台      12 m 宽 × 450 m 长，站台面 +1.25 m（国铁标准）
  站台中心距    22 m（对应线间距 5.0 m + 站台宽度）
  线路          10 座岛式站台 / 20 线，车场南北向净宽 220 m
  主站房屋面    300 m（东西）× 236 m（南北），檐口 +38 m
  两侧雨棚      各 75 m（东西），覆盖 150→225 m
  南广场        600 m 宽 × 342 m 深（站房南立面至南端步行桥）
"""
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "scene.ssdl")
SEED = 20260913

# ---------------------------------------------------------------- 参数
PLAT_N = 10
PLAT_PITCH = 22.0
PLAT_W = 12.0
PLAT_LEN = 450.0
PLAT_H = 1.25
TRACK_OFF = 7.75            # 线中心相对站台中心

PLAT_YS = [(i - (PLAT_N - 1) / 2.0) * PLAT_PITCH for i in range(PLAT_N)]
YARD_S = PLAT_YS[0] - 11.0
YARD_N = PLAT_YS[-1] + 11.0          # ≈ ±110

HALL_W = 300.0
HALL_D = 236.0
ROOF_Z = 38.0
HALL_Y_S = -HALL_D / 2.0
HALL_XW = HALL_W / 2.0

CAN_X1 = PLAT_LEN / 2.0              # 225
CAN_X0 = HALL_XW                     # 150
CANOPY_Z = 8.4

PLAZA_Y0 = HALL_Y_S                  # -118
PLAZA_Y1 = -368.0
PLAZA_XW = 300.0


def n(x):
    if abs(x) < 5e-4:
        return "0"
    s = "%.3f" % x
    s = s.rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def v3(p):
    return "[%s, %s, %s]" % (n(p[0]), n(p[1]), n(p[2]))


def v4(p):
    return "[%s, %s, %s, %s]" % (n(p[0]), n(p[1]), n(p[2]), n(p[3]))


L = []
def w(s=""):
    L.append(s)


def qz(deg):
    """绕 Z 轴四元数。"""
    a = math.radians(deg)
    return [0.0, 0.0, math.sin(a / 2), math.cos(a / 2)]


def qx(deg):
    a = math.radians(deg)
    return [math.sin(a / 2), 0.0, 0.0, math.cos(a / 2)]


def mat(target, tex=None, uv=None, tint=None, rough=0.9, metal=0.0,
        nmap=None, nscale=1.0, extra=""):
    if tex:
        nm = "; normalMap: %s; normalScale: %s" % (nmap, n(nscale)) if nmap else ""
        w("  PrincipledMaterial { target: %s; baseColor: \"%s\"; baseColorMap: %s; "
          "uvScale: [%s, %s]; metalness: %s; roughness: %s%s%s }"
          % (target, tint or "#ffffff", tex, n(uv[0]), n(uv[1]), n(metal), n(rough), nm, extra))
    else:
        w("  PrincipledMaterial { target: %s; baseColor: \"%s\"; metalness: %s; roughness: %s%s }"
          % (target, tint or "#ffffff", n(metal), n(rough), extra))


def box(nid, wx, dy, hz, pos, color=None, tex=None, uv=None, rot=None,
        rough=0.9, metal=0.0):
    r = "; rotation: " + v4(rot) if rot else ""
    c = "; color: \"%s\"" % color if color else ""
    w("  Box { id: %s; width: %s; depth: %s; height: %s; position: %s%s%s }"
      % (nid, n(wx), n(dy), n(hz), v3(pos), c, r))
    if tex:
        mat(nid, tex, uv, tint=color, rough=rough, metal=metal)


def src_box(nid, wx, dy, hz, color, tex=None, uv=None, emit_mat=True,
            rough=0.9, metal=0.0):
    """Prefab 源用：position 固定 [0,0,0] + visible:false。"""
    w("  Box { id: %s; visible: false; width: %s; depth: %s; height: %s; position: [0, 0, 0] }"
      % (nid, n(wx), n(dy), n(hz)))
    if emit_mat:
        mat(nid, tex, uv, tint=color, rough=rough, metal=metal)


def src_loft(nid, spec, tex=None, uv=None, tint=None, rough=0.9, metal=0.0,
             emit_mat=True, nmap=None, nscale=1.0):
    w("  Loft { id: %s; visible: false; cap: true;" % nid)
    w("    sections: [" + ", ".join(
        "[" + ", ".join(v3(p) for p in r) + "]" for r in spec) + "] }")
    if emit_mat:
        mat(nid, tex, uv, tint, rough, metal, nmap, nscale)


def rect_ring(wx, dy, z, cx=0.0, cy=0.0, ch=0.0):
    hw, hd = wx / 2.0, dy / 2.0
    if ch > 0:
        c = min(ch, hw * 0.6, hd * 0.6)
        pts = [(hw, -hd + c), (hw, hd - c), (hw - c, hd), (-hw + c, hd),
               (-hw, hd - c), (-hw, -hd + c), (-hw + c, -hd), (hw - c, -hd)]
    else:
        pts = [(hw, -hd), (hw, hd), (-hw, hd), (-hw, -hd)]
    return [(cx + x, cy + y, z) for (x, y) in pts]


def instances(nid, prefab, positions):
    if len(positions) < 2:
        return
    chunks = [positions[i:i + 250] for i in range(0, len(positions), 250)]
    for ci, ch in enumerate(chunks):
        if len(ch) < 2:
            continue
        w("  Instances { id: %s%s; prefab: %s; placement: \"explicit\"; positions: [%s] }"
          % (nid, "" if len(chunks) == 1 else "_%d" % (ci + 1), prefab,
             ", ".join(v3(p) for p in ch)))


rng = random.Random(SEED)

# ================================================================ 输出
w("// =============================================================")
w("//  深圳北站 Shenzhen North Station —— 程序化生成，勿手改")
w("//  改 gen_tex.py / gen_station.py 后重跑；尺度基准见 README.md")
w("// =============================================================")
w("Scene {")
w("  id: main")
w()
w("  // ---------------- 可运行时驱动的机位（便于出多机位验证图，无需重编译）----------------")
w("  //  默认值 = 对照参考图的南侧高空俯瞰；用 ssworld_logic_write 改这些属性即可换机位")
w("  property length camX: 6")
w("  property length camY: -700")
w("  property length camZ: 268")
w("  property degrees camHeading: 0")
w("  property degrees camPitch: -15")
w("  property degrees camFov: 58")
w()
w("  CameraView { id: heroView; position: [camX, camY, camZ];")
w("    heading: camHeading; pitch: camPitch; fov: camFov }")
w("  Camera { id: mainCamera; initialView: heroView }")
w()
w("  // ---------------- 大气（夏日雨后薄霾）----------------")
w("  SkyAtmosphere { id: sky }")
w("  DirectionalLight { id: sun; atmosphereSunLight: true; intensity: 1.5;")
w("    lightColor: \"#fff2dc\"; sunAzimuth: 172; sunElevation: 63; castShadows: true }")
w("  SkyLight { id: skyFill; intensity: 0.62; lowerHemisphereColor: \"#8a8b80\" }")
w("  ExponentialHeightFog { id: haze; fogDensity: 0.00058; fogHeightFalloff: 0.008;")
w("    startDistance: 260; fogMaxOpacity: 0.52; fogCutoffDistance: 6000;")
w("    fogInscatteringColor: \"#ccd8e0\"; directionalInscatteringColor: \"#e6eef4\";")
w("    directionalInscatteringExponent: 5 }")
w("  PostProcessVolume { id: post; unbound: true;")
w("    settings.autoExposureBias: 0.46;")
w("    settings.autoExposureMinBrightness: 1.0; settings.autoExposureMaxBrightness: 1.0;")
w("    settings.bloomThreshold: 1.2;")
w("    settings.bloomIntensity: 0.3; settings.ambientOcclusionIntensity: 0.62;")
w("    settings.ambientOcclusionPower: 1.8; settings.ambientOcclusionFadeDistance: 60;")
w("    settings.toneCurveAmount: 1; settings.vignetteIntensity: 0.12 }")
w()

# ---------------- 贴图 ----------------
w("  // ---------------- 程序化贴图（gen_tex.py）----------------")
for tid, f in (("roof", "roof_grid.png"), ("roofN", "roof_grid_n.png"),
               ("canopy", "canopy_rib.png"), ("canopyN", "canopy_rib_n.png"), ("plaza", "plaza_pave.png"), ("paveL", "pave_light.png"),
               ("paveD", "pave_dark.png"), ("asph", "asphalt.png"),
               ("conc", "concrete.png"), ("metal", "metal_panel.png"),
               ("glass", "glass_tower.png"), ("skyl", "skylight.png"),
               ("resid", "resid_stripe.png"), ("leaf", "surf_leaf.png"),
               ("grass", "surf_grass.png"), ("forest", "hill_forest.png"), ("sign", "sign_main.png")):
    w("  Texture { id: tex_%s; source: \"assets/%s\" }" % (tid, f))
w()

# ================================================================ 地形
w("  // ---------------- 地形基面 ----------------")
w("  Plane { id: ground; width: 4200; depth: 4200; position: [0, -180, -0.10] }")
w("  PrincipledMaterial { target: ground; baseColorMap: tex_grass; uvScale: [300, 300]; roughness: 0.95 }")
w("  Plane { id: cityFloor; width: 3800; depth: 1900; position: [0, -740, -0.06] }")
w("  PrincipledMaterial { target: cityFloor; baseColorMap: tex_paveD; uvScale: [80, 40]; roughness: 0.9 }")
w()

# 北侧地形：从站房以北 420 m 起坡，缓升到塘朗山脊（连续地形，不是"平地 + 远处山"）
HC, HR = 60, 44
HW, HD = 3800.0, 2600.0
HILL_CX, HILL_CY = 140.0, 1300.0
HILL_H = 68.0
HILL_RISE_Y = 620.0        # 此处开始起坡
HILL_FULL_Y = 1820.0       # 此处到达设计高度


def terrain_h(x, y):
    """地形高程；站区（y < 420）恒为 0，保证不与站台/广场冲突。"""
    u = (x - HILL_CX) / (HW / 2.0)
    if abs(u) > 1.05 or y < 0.0 or y > HILL_CY + HD / 2.0:
        return 0.0
    t = max(0.0, min(1.0, (y - HILL_RISE_Y) / (HILL_FULL_Y - HILL_RISE_Y)))
    if t <= 0.0:
        return 0.0
    v = (y - HILL_CY) / (HD / 2.0)
    h = HILL_H * (t ** 1.30)
    h *= (1.0 + 0.32 * math.sin(u * 6.1 + 0.6) * math.cos(v * 3.7 + 1.1)
          + 0.18 * math.sin(u * 13.0 + 2.2) * math.cos(v * 9.0)
          + 0.09 * math.sin(u * 27.0) * math.cos(v * 21.0))
    h *= max(0.0, min(1.0, (1.05 - abs(u)) / 0.16))          # 东西缘收头
    h *= max(0.0, min(1.0, (HILL_CY + HD / 2.0 - y) / 260.0))  # 北缘收头
    return max(0.0, h)


heights = []
for j in range(HR + 1):
    y = HILL_CY + ((j / float(HR)) * 2 - 1) * (HD / 2.0)
    for i in range(HC + 1):
        x = HILL_CX + ((i / float(HC)) * 2 - 1) * (HW / 2.0)
        heights.append(terrain_h(x, y))
w("  // ---------------- 北侧塘朗山系（HeightField 连续地形）----------------")
w("  HeightField { id: hills; width: %s; depth: %s; columns: %d; rows: %d;"
  % (n(HW), n(HD), HC, HR))
w("    position: [%s, %s, -0.02]" % (n(HILL_CX), n(HILL_CY)))
w("    heights: [" + ", ".join(n(h) for h in heights) + "] }")
w("  PrincipledMaterial { target: hills; baseColorMap: tex_forest;")
w("    uvScale: [210, 112]; roughness: 0.96 }")
w()

# ================================================================ 车场
w("  // ============================================================")
w("  //  车场：整体道床 + 10 座岛式站台 + 20 线")
w("  // ============================================================")
box("yardBed", PLAT_LEN + 60, YARD_N - YARD_S, 0.30,
    [0, (YARD_S + YARD_N) / 2.0, 0.15], "#6b6a66", "tex_asph", [40, 12])

# 轨道（无砟整体道床：轨道板 + 两根钢轨，轨距 1435 mm）
w("  // ---------------- 无砟轨道（20 线）----------------")
src_box("trackSlab", PLAT_LEN, 2.6, 0.10, "#8e8c86", "tex_conc", [60, 1], rough=0.88)
w("  Prefab { id: pfTrackSlab; source: trackSlab }")
src_box("railSteel", PLAT_LEN, 0.075, 0.18, "#4a4d52", None, None, metal=0.85, rough=0.30)
w("  Prefab { id: pfRail; source: railSteel }")
slab_pos, rail_pos = [], []
for y in PLAT_YS:
    for s in (-1, 1):
        yt = y + s * TRACK_OFF
        slab_pos.append((0.0, yt, 0.35))
        for g in (-1, 1):
            rail_pos.append((0.0, yt + g * 0.7175, 0.39))
instances("instTrackSlab", "pfTrackSlab", slab_pos)
instances("instRail", "pfRail", rail_pos)

# 站台（预制源 + 实例）
src_box("platBody", PLAT_LEN, PLAT_W, PLAT_H, "#cfccc4", "tex_paveL", [24, 1])
w("  Prefab { id: pfPlat; source: platBody }")
instances("instPlat", "pfPlat",
          [(0.0, y, PLAT_H / 2.0) for y in PLAT_YS])
# 站台边缘黄线
src_box("platEdge", PLAT_LEN, 0.55, 0.06, "#d8b23c")
w("  Prefab { id: pfPlatEdge; source: platEdge }")
instances("instPlatEdge", "pfPlatEdge",
          [(0.0, y + s * (PLAT_W / 2.0 - 0.6), PLAT_H + 0.03)
           for y in PLAT_YS for s in (-1, 1)])
w()

# 雨棚（东西两侧各 75 m）
crown = [rect_ring(CAN_X1 - CAN_X0, 15.5, 6.6),
         rect_ring(CAN_X1 - CAN_X0, 15.5, 8.0),
         rect_ring(CAN_X1 - CAN_X0, 5.0, 8.9)]
w("  // ---------------- 站台雨棚（东西两侧各 75 m，屋脊朝东西）----------------")
src_loft("canopyRoof", crown, tex="tex_canopy", uv=[26, 1], tint="#eae9e4",
         rough=0.55, metal=0.06, nmap="tex_canopyN", nscale=1.1)
w("  Prefab { id: pfCanopy; source: canopyRoof }")
can_pos = []
for x0 in (-(CAN_X0 + CAN_X1) / 2.0, (CAN_X0 + CAN_X1) / 2.0):
    for y in PLAT_YS:
        can_pos.append((x0, y, 0.0))
instances("instCanopy", "pfCanopy", can_pos)

# 雨棚柱 + 站台柱
src_box("canopyCol", 0.55, 0.55, 6.6, "#d5d2ca", "tex_conc", [1, 6])
w("  Prefab { id: pfCanopyCol; source: canopyCol }")
col_pos = []
for x0 in (-(CAN_X0 + CAN_X1) / 2.0, (CAN_X0 + CAN_X1) / 2.0):
    for y in PLAT_YS:
        for dx in (-33.0, 0.0, 33.0):
            col_pos.append((x0 + dx, y, PLAT_H + 3.3))
instances("instCanopyCol", "pfCanopyCol", col_pos)
w()

# 雨棚纵向连梁（柱顶三道）+ 柱顶节点板：把"一排柱子"变成"一榀结构"
w("  // ---------------- 雨棚柱顶连梁 ----------------")
src_box("canopyBeam", CAN_X1 - CAN_X0 + 4.0, 0.55, 0.85, "#c8c5bd", "tex_metal", [34, 1],
        metal=0.25, rough=0.55)
w("  Prefab { id: pfCanopyBeam; source: canopyBeam }")
src_box("canopyCap", 1.5, 1.5, 0.35, "#b9b6ae", "tex_metal", [1, 1], metal=0.3, rough=0.5)
w("  Prefab { id: pfCanopyCap; source: canopyCap }")
beam_pos, cap_pos = [], []
for sx in (-1, 1):
    x0 = sx * (CAN_X0 + CAN_X1) / 2.0
    for y in PLAT_YS:
        for dx in (-33.0, 0.0, 33.0):
            beam_pos.append((x0 + dx, y, 6.35))
            cap_pos.append((x0 + dx, y, 6.05))
instances("instCanopyBeam", "pfCanopyBeam", beam_pos)
instances("instCanopyCap", "pfCanopyCap", cap_pos)
w()

# 雨棚檐口（端部 + 两侧封边）：一块光板读不出"构筑物"，加封边后屋面才有厚度和阴影线
w("  // ---------------- 雨棚檐口封边 ----------------")
src_box("canopyFasX", 0.9, 16.5, 1.5, "#9aa0a4", "tex_metal", [1, 1], metal=0.35, rough=0.55)
w("  Prefab { id: pfCanopyFasX; source: canopyFasX }")
src_box("canopyFasY", CAN_X1 - CAN_X0 + 1.0, 0.9, 1.5, "#9aa0a4", "tex_metal", [24, 1],
        metal=0.35, rough=0.55)
w("  Prefab { id: pfCanopyFasY; source: canopyFasY }")
fas_x, fas_y = [], []
can_cx = (CAN_X0 + CAN_X1) / 2.0
for sx in (-1, 1):
    for y in PLAT_YS:
        for ex in (CAN_X0, CAN_X1):
            fas_x.append((sx * ex, y, 6.9))
        for ey in (-7.75, 7.75):
            fas_y.append((sx * can_cx, y + ey, 6.9))
instances("instCanopyFasX", "pfCanopyFasX", fas_x)
instances("instCanopyFasY", "pfCanopyFasY", fas_y)
w()

# 接触网立柱（沿车场外侧）
src_box("mastPole", 0.42, 0.42, 11.5, "#8b8f92", None, None, metal=0.55, rough=0.50)
w("  Prefab { id: pfMast; source: mastPole }")
mast = []
for k in range(9):
    x = -PLAT_LEN / 2.0 + 6 + k * 54.0
    for y in (YARD_S - 3.0, YARD_N + 3.0):
        mast.append((x, y, 5.75))
instances("instMast", "pfMast", mast)
w()

# 接触网：承力索 + 接触线（每线一组）+ 腕臂
w("  // ---------------- 接触网（20 线：承力索 + 接触线 + 腕臂）----------------")
src_box("wireMess", PLAT_LEN, 0.055, 0.055, "#6f7377", None, None, metal=0.75, rough=0.40)
w("  Prefab { id: pfWireMess; source: wireMess }")
src_box("wireCont", PLAT_LEN, 0.050, 0.050, "#5c6064", None, None, metal=0.80, rough=0.35)
w("  Prefab { id: pfWireCont; source: wireCont }")
wire_m, wire_c = [], []
for y in PLAT_YS:
    for s in (-1, 1):
        yt = y + s * TRACK_OFF
        wire_m.append((0.0, yt, 6.60))      # 承力索
        wire_c.append((0.0, yt, 5.30))      # 接触线
instances("instWireMess", "pfWireMess", wire_m)
instances("instWireCont", "pfWireCont", wire_c)
# 腕臂：从立柱伸向最近一条线
src_box("cantilever", 0.16, 3.2, 0.16, "#7d8185", None, None, metal=0.7, rough=0.45)
w("  Prefab { id: pfCantilever; source: cantilever }")
src_box("cantInsul", 0.34, 0.34, 0.34, "#c9c4b4", None, None, metal=0.05, rough=0.55)
w("  Prefab { id: pfCantInsul; source: cantInsul }")
cant, ins = [], []
for k in range(9):
    x = -PLAT_LEN / 2.0 + 6 + k * 54.0
    cant.append((x, YARD_S - 1.5, 9.4))
    ins.append((x, YARD_S - 2.7, 9.4))
    cant.append((x, YARD_N + 1.5, 9.4))
    ins.append((x, YARD_N + 2.7, 9.4))
instances("instCantilever", "pfCantilever", cant)
instances("instCantInsul", "pfCantInsul", ins)
w()

# ================================================================ 主站房
w("  // ============================================================")
w("  //  主站房：300 × 236 m 大跨屋面，檐口 +38 m")
w("  // ============================================================")
RC, RR = 58, 46
rh = []
for j in range(RR + 1):
    for i in range(RC + 1):
        u = (i / float(RC)) * 2 - 1
        v = (j / float(RR)) * 2 - 1
        # 南北向缓拱 + 边缘起翘
        h = 1.6 * math.cos(u * math.pi / 2) * (1.0 - 0.35 * abs(v)) \
            + 0.9 * math.cos(v * math.pi / 2)
        rh.append(ROOF_Z + h - 2.2)
w("  HeightField { id: hallRoof; width: %s; depth: %s; columns: %d; rows: %d;"
  % (n(HALL_W), n(HALL_D), RC, RR))
w("    position: [0, 0, 0]")
w("    heights: [" + ", ".join(n(h) for h in rh) + "] }")
w("  // 格栅尺度：格 4.0 m（实拍量级），贴图 16 格 = 64 m，故 uvScale = 屋面尺寸 / 64")
w("  PrincipledMaterial { target: hallRoof; baseColorMap: tex_roof; normalMap: tex_roofN;")
w("    normalScale: 1.7; uvScale: [4.7, 3.7]; metalness: 0.05; roughness: 0.62 }")
w()

# 屋面四周檐口封边
box("fasciaN", HALL_W + 3.0, 1.6, 3.4, [0, HALL_D / 2.0 + 0.4, ROOF_Z - 1.4],
    "#dedbd3", "tex_metal", [40, 1])
box("fasciaE", 1.6, HALL_D + 3.0, 3.4, [HALL_W / 2.0 + 0.4, 0, ROOF_Z - 1.4],
    "#dedbd3", "tex_metal", [30, 1])
box("fasciaW", 1.6, HALL_D + 3.0, 3.4, [-HALL_W / 2.0 - 0.4, 0, ROOF_Z - 1.4],
    "#dedbd3", "tex_metal", [30, 1])
# 南立面：倾斜的檐口带（标识载体）
w("  // ---------------- 南立面倾斜檐口 + \"深圳北站\" 标识（标识贴面在檐口之前）----------------")
box("fasciaS", HALL_W + 3.0, 2.4, 13.0, [0, HALL_Y_S - 0.6, 31.4], "#e4e1d9", "tex_metal", [46, 2])
w("  // 注意：Plane 的贴图正面在 -Z 侧，标识板要转 180°-64° 才不是镜像")
w("  Plane { id: fasciaSlope; width: %s; depth: 14; position: [0, -120.8, 30.8];"
  % n(HALL_W + 3))
w("    rotation: %s }" % v4(qx(64)))
w("  PrincipledMaterial { target: fasciaSlope; baseColorMap: tex_metal; uvScale: [44, 2];")
w("    metalness: 0.1; roughness: 0.62 }")
w("  // Plane 贴图在 +Z 侧可见（-Z 侧被背面剔除），且渲染为水平镜像；")
w("  // 故朝向用 qx(64)，贴图本体已在 gen_tex.py 里水平翻转")
w("  Plane { id: signBoard; width: 46; depth: 15.3; position: [0, -122.35, 31.55];")
w("    rotation: %s }" % v4(qx(64)))
w("  PrincipledMaterial { target: signBoard; baseColorMap: tex_sign; uvScale: [1, 1];")
w("    metalness: 0.05; roughness: 0.55 }")
w()

# 主站房下部的站厅体量（南侧玻璃幕墙 + 柱廊）
box("hallBody", HALL_W - 24.0, HALL_D - 30.0, 26.0, [0, -6.0, 13.0],
    "#4c5760", "tex_glass", [46, 7])
box("hallBase", HALL_W + 8.0, HALL_D + 8.0, 1.1, [0, 0, 0.55], "#dcd9d1", "tex_plaza", [13, 10])
# 南侧柱廊
src_box("hallCol", 1.5, 1.5, 27.0, "#d9d6ce", "tex_conc", [1, 10])
w("  Prefab { id: pfHallCol; source: hallCol }")
# 柱头 / 柱础：把"一排方柱"变成有收头的柱廊
src_box("hallCap", 2.3, 2.3, 1.1, "#e0ddd5", "tex_conc", [1, 1])
w("  Prefab { id: pfHallCap; source: hallCap }")
src_box("hallPlinth", 2.0, 2.0, 0.9, "#bfbcb4", "tex_conc", [1, 1])
w("  Prefab { id: pfHallPlinth; source: hallPlinth }")
hc, hcap, hpl = [], [], []
for k in range(21):
    x = -HALL_W / 2.0 + 8 + k * (HALL_W - 16) / 20.0
    yc = HALL_Y_S + 4.0
    hc.append((x, yc, 13.5))
    hcap.append((x, yc, 26.5))
    hpl.append((x, yc, 1.5))
instances("instHallCol", "pfHallCol", hc)
instances("instHallCap", "pfHallCap", hcap)
instances("instHallPlinth", "pfHallPlinth", hpl)
# 南侧雨篷
box("entryCanopy", HALL_W - 10.0, 16.0, 1.2, [0, HALL_Y_S - 9.0, 27.0],
    "#e2dfd7", "tex_metal", [40, 2])
# 檐下白色横梁 + 底部勒脚梁，把"屋面/玻璃/基座"三段拉开
box("entryBeam", HALL_W - 6.0, 2.0, 1.8, [0, HALL_Y_S + 1.0, 25.4], "#e6e3db", "tex_metal", [46, 1])
box("entryBeam2", HALL_W - 6.0, 2.0, 1.2, [0, HALL_Y_S + 1.0, 3.2], "#ddd9d1", "tex_metal", [46, 1])
w()

# ================================================================ 南广场
w("  // ============================================================")
w("  //  南广场：600 × 342 m 轴线广场")
w("  // ============================================================")
box("plaza", 2 * PLAZA_XW, PLAZA_Y0 - PLAZA_Y1, 0.24,
    [0, (PLAZA_Y0 + PLAZA_Y1) / 2.0, 0.12], "#d9d6cd", "tex_plaza", [25, 14])
# 广场中心区大模数铺装（对照实拍：轴线一带是更大尺度的方格，与外围细铺装区分开）
box("plazaCore", 168.0, 250.0, 0.30, [0, PLAZA_Y0 - 128.0, 0.15],
    "#cbc8bf", "tex_paveL", [5.2, 7.8])
box("plazaCoreFrame", 176.0, 6.0, 0.34, [0, PLAZA_Y0 - 6.0, 0.17], "#a8a59d", "tex_paveD", [14, 1])
box("plazaCoreFrame2", 176.0, 6.0, 0.34, [0, PLAZA_Y0 - 250.0, 0.17], "#a8a59d", "tex_paveD", [14, 1])
box("plazaCoreFrameW", 6.0, 250.0, 0.34, [-85.0, PLAZA_Y0 - 128.0, 0.17], "#a8a59d", "tex_paveD", [1, 20])
box("plazaCoreFrameE", 6.0, 250.0, 0.34, [85.0, PLAZA_Y0 - 128.0, 0.17], "#a8a59d", "tex_paveD", [1, 20])
# 中轴系柱（对照实拍：轴线两侧成对的短柱阵）
src_box("axisBollard", 0.9, 0.9, 3.6, "#c9c6be", "tex_conc", [1, 2])
w("  Prefab { id: pfBollard; source: axisBollard }")
instances("instBollard", "pfBollard",
          [(sx * 12.5, PLAZA_Y0 - 20.0 - k * 22.0, 1.8)
           for sx in (-1, 1) for k in range(10)])
# 中轴深色石带
box("axisBand", 22.0, PLAZA_Y0 - PLAZA_Y1, 0.10,
    [0, (PLAZA_Y0 + PLAZA_Y1) / 2.0, 0.26], "#a9a69e", "tex_paveD", [1, 30])
# 两侧横向石带（营造铺装分格）
src_box("bandTile", 2 * PLAZA_XW * 0.42, 3.2, 0.07, "#b3b0a8", "tex_paveD", [10, 1])
w("  Prefab { id: pfBand; source: bandTile }")
bands = [(0.0, PLAZA_Y1 + 24 + k * 34.0, 0.30) for k in range(9)]
instances("instBand", "pfBand", bands)
# 纵向石带（与横带交织成广场铺装网格）
src_box("bandTileV", 3.2, PLAZA_Y0 - PLAZA_Y1 - 20.0, 0.07, "#b3b0a8", "tex_paveD", [1, 26])
w("  Prefab { id: pfBandV; source: bandTileV }")
instances("instBandV", "pfBandV",
          [(sx * xk, (PLAZA_Y0 + PLAZA_Y1) / 2.0, 0.30)
           for sx in (-1, 1) for xk in (46.0, 96.0, 152.0, 214.0, 268.0)])
# 绿化地块（对照参考图广场上的规整草坪）
src_box("lawnPanel", 22.0, 96.0, 0.10, "#6f8a4a", "tex_grass", [2, 9])
w("  Prefab { id: pfLawn; source: lawnPanel }")
lawns = []
for sx in (-1, 1):
    for k in range(3):
        y = PLAZA_Y0 - 74.0 - k * 108.0
        for xk in (46.0, 96.0):
            lawns.append((sx * xk, y, 0.30))
    for k in range(2):
        lawns.append((sx * 156.0, PLAZA_Y0 - 96.0 - k * 130.0, 0.30))
    lawns.append((sx * 232.0, PLAZA_Y0 - 120.0, 0.30))
instances("instLawn", "pfLawn", lawns)
# 广场南北向人行道压条
src_box("walkStrip", 6.0, 320.0, 0.05, "#bdbab2", "tex_paveL", [1, 26])
w("  Prefab { id: pfWalkStrip; source: walkStrip }")
instances("instWalkStrip", "pfWalkStrip",
          [(sx * xk, PLAZA_Y1 + 180.0, 0.29) for sx in (-1, 1) for xk in (23.0, 70.0, 124.0, 184.0, 240.0)])
w()

# 广场东西两侧配楼（对照实拍：夹持广场的低层配套，给广场一个边界）
w("  // ---------------- 广场两侧配楼 ----------------")
pav_spec = [rect_ring(96, 26, 0), rect_ring(96, 26, 13), rect_ring(92, 22, 16)]
src_loft("plazaPav", pav_spec, tex="tex_conc", uv=[10, 2], tint="#d3d0c8",
         rough=0.7, metal=0.05)
w("  Prefab { id: pfPlazaPav; source: plazaPav }")
instances("instPlazaPav", "pfPlazaPav",
          [(sx * 268.0, y, 0.0)
           for sx in (-1, 1) for y in (PLAZA_Y0 - 62.0, PLAZA_Y0 - 176.0)])
# 配楼雨篷
src_box("pavCanopy", 100.0, 34.0, 0.9, "#e3e0d8", "tex_metal", [26, 9], metal=0.15, rough=0.5)
w("  Prefab { id: pfPavCanopy; source: pavCanopy }")
instances("instPavCanopy", "pfPavCanopy",
          [(sx * 268.0, y, 16.6)
           for sx in (-1, 1) for y in (PLAZA_Y0 - 62.0, PLAZA_Y0 - 176.0)])
w()

# 下沉庭院 + 玻璃采光顶 + 水池
w("  // ---------------- 下沉庭院 / 采光顶 / 水池 ----------------")
box("sinkWall", 168.0, 92.0, 7.0, [0, -224.0, -3.5], "#b8b5ad", "tex_conc", [14, 1])
box("sinkFloor", 160.0, 84.0, 0.2, [0, -224.0, -0.4], "#9d9a93", "tex_paveD", [12, 8])
w("  Box { id: skyRoof; width: 96; depth: 56; height: 1.1; position: [0, -214, 1.0] }")
w("  PrincipledMaterial { target: skyRoof; baseColorMap: tex_skyl; uvScale: [8, 5];")
w("    metalness: 0.35; roughness: 0.18 }")
w("  Box { id: pool; width: 118; depth: 40; height: 0.5; position: [0, -262, 0.16] }")
w("  PrincipledMaterial { target: pool; baseColor: \"#31434c\"; metalness: 0.55; roughness: 0.08 }")
# 球体雕塑
w("  Cylinder { id: globeBase; radius: 7.0; height: 3.4; segments: 24; position: [0, -290, 1.7] }")
w("  PrincipledMaterial { target: globeBase; baseColor: \"#b9b6ae\"; metalness: 0.1; roughness: 0.7 }")
w("  Sphere { id: globe; radius: 9.0; segments: 32; position: [0, -290, 14.0] }")
w("  PrincipledMaterial { target: globe; baseColor: \"#5d6a70\"; metalness: 0.75; roughness: 0.22 }")
# 下沉庭院周边栏杆
src_box("railPost", 0.12, 0.12, 1.1, "#8d9095", None, None, metal=0.70, rough=0.35)
w("  Prefab { id: pfRailPost; source: railPost }")
rp = []
for k in range(35):
    x = -84.0 + k * 5.0
    rp.append((x, -180.0, 0.8))
    rp.append((x, -260.0, 0.8))
instances("instRailPost", "pfRailPost", rp)
w()

# 树阵
w("  // ---------------- 广场树阵 ----------------")
tree_prof = [[0.10, 0, 0], [0.46, 0, 0.30], [0.40, 0, 2.30], [1.10, 0, 2.80],
             [2.45, 0, 3.60], [3.30, 0, 4.80], [3.45, 0, 6.00], [2.70, 0, 7.10],
             [1.25, 0, 7.70], [0.10, 0, 8.00]]
w("  Lathe { id: treeA; visible: false; segments: 12; closed: false;")
w("    profile: [" + ", ".join(v3(p) for p in tree_prof) + "] }")
w("  PrincipledMaterial { target: treeA; baseColorMap: tex_leaf; uvScale: [4, 3]; roughness: 0.92 }")
tree_prof2 = [[0.10, 0, 0], [0.42, 0, 0.26], [0.36, 0, 2.10], [1.35, 0, 2.60],
              [2.85, 0, 3.40], [3.00, 0, 5.10], [2.20, 0, 6.40], [0.10, 0, 7.10]]
w("  Lathe { id: treeB; visible: false; segments: 10; closed: false;")
w("    profile: [" + ", ".join(v3(p) for p in tree_prof2) + "] }")
w("  PrincipledMaterial { target: treeB; baseColorMap: tex_leaf; uvScale: [4, 3];")
w("    baseColor: \"#c8d8bc\"; roughness: 0.92 }")
w("  Prefab { id: pfTreeA; source: treeA }")
w("  Prefab { id: pfTreeB; source: treeB }")

treeA, treeB = [], []
Y0T, Y1T = PLAZA_Y0 - 8.0, PLAZA_Y1 + 16.0
for sx in (-1, 1):
    # 主轴两侧列植
    y = Y0T
    while y > Y1T:
        (treeA if rng.random() < 0.6 else treeB).append((sx * 30.0, y, 0.24))
        y -= 11.0
    # 外侧列植
    for xk, pitch in ((66.0, 13.0), (104.0, 15.0), (146.0, 16.0), (196.0, 18.0),
                      (250.0, 20.0)):
        y = Y0T - rng.uniform(0, 6)
        while y > Y1T:
            (treeA if rng.random() < 0.55 else treeB).append((sx * xk, y, 0.24))
            y -= pitch
# 站房两翼绿化
for sx in (-1, 1):
    for k in range(26):
        x = sx * rng.uniform(160, 470)
        y = rng.uniform(-120, 120)
        (treeA if rng.random() < 0.5 else treeB).append((x, y, 0.1))
# 山脚绿化：贴着地形起伏放，z 由 terrain_h 算出来（否则会悬空或埋进坡里）
for _ in range(230):
    x = rng.uniform(-1500, 1600)
    y = rng.uniform(700, 1500)
    (treeA if rng.random() < 0.45 else treeB).append((x, y, terrain_h(x, y) + 0.2))
# 站北绿带植树（成片）
for _ in range(430):
    x = rng.uniform(-640, 640)
    y = rng.uniform(150, 660)
    (treeA if rng.random() < 0.52 else treeB).append((x, y, terrain_h(x, y) + 0.2))
for _ in range(520):
    x = rng.uniform(-1500, 1600)
    y = rng.uniform(680, 1750)
    (treeA if rng.random() < 0.45 else treeB).append((x, y, terrain_h(x, y) + 0.2))
# 广场边绿化
for _ in range(120):
    sx = rng.choice((-1, 1))
    (treeA if rng.random() < 0.5 else treeB).append(
        (sx * rng.uniform(320, 620), rng.uniform(-440, -140), 0.1))
instances("instTreeA", "pfTreeA", treeA)
instances("instTreeB", "pfTreeB", treeB)
w()

# 广场照明桅杆
w("  // ---------------- 高杆灯 / 广场设施 ----------------")
src_box("mastPole2", 0.30, 0.30, 16.0, "#9a9d9f", None, None, metal=0.60, rough=0.40)
w("  Prefab { id: pfMast2; source: mastPole2 }")
src_box("mastHead", 2.6, 1.1, 0.35, "#b6b9bb", None, None, metal=0.60, rough=0.35)
w("  Prefab { id: pfMastHead; source: mastHead }")
mp, mh = [], []
for sx in (-1, 1):
    for k in range(6):
        x = sx * 92.0
        y = PLAZA_Y0 - 26.0 - k * 56.0
        mp.append((x, y, 8.0))
        mh.append((x, y, 16.2))
instances("instMast2", "pfMast2", mp)
instances("instMastHead", "pfMastHead", mh)
w()

# 南端步行桥 + 台阶
w("  // ---------------- 南端步行桥 / 大台阶 ----------------")
box("bridgeDeck", 2 * PLAZA_XW, 17.0, 1.6, [0, PLAZA_Y1 + 2.0, 8.2],
    "#cfccc4", "tex_paveL", [30, 1])
box("bridgeEdge", 2 * PLAZA_XW, 0.6, 1.6, [0, PLAZA_Y1 - 6.6, 8.9], "#8d9095", "tex_metal", [60, 1])
src_box("bridgeCol", 1.2, 1.2, 7.4, "#c4c1b9", "tex_conc", [1, 3])
w("  Prefab { id: pfBridgeCol; source: bridgeCol }")
instances("instBridgeCol", "pfBridgeCol",
          [(x, PLAZA_Y1 + 2.0, 3.7) for x in range(-280, 281, 40)])
# 台阶（下沉庭院两侧进入）
for sx in (-1, 1):
    for k in range(6):
        box("step%s%d" % ("W" if sx < 0 else "E", k), 26.0, 1.5, 0.9,
            [sx * 102.0, -182.0 - k * 1.5, 0.45 - k * 0.9], "#c2bfb7", "tex_paveL", [8, 1])
w()

# ================================================================ 周边
w("  // =============================================================")
w("  //  周边：西侧住宅群（橙白条纹）、东侧站区配套、办公塔楼")
w("  // =============================================================")

# 住宅塔（橙白条纹，对照参考图左上角）：一张贴图 24 m == 8 组条纹
res_spec = [rect_ring(26, 22, 0), rect_ring(26, 22, 88), rect_ring(24, 20, 96)]
src_loft("resTower", res_spec, tex="tex_resid", uv=[4, 3.7], rough=0.8)
w("  Prefab { id: pfResTower; source: resTower }")
res_pos = []
for r in range(4):
    for c in range(5):
        res_pos.append((-1240 + c * 78 + rng.uniform(-4, 4),
                        400 + r * 88 + rng.uniform(-5, 5),
                        terrain_h(-1240 + c * 78, 400 + r * 88)))
for c in range(4):
    res_pos.append((-620 + c * 74, 268 + rng.uniform(-6, 6), terrain_h(-620 + c * 74, 268)))
instances("instResTower", "pfResTower", res_pos)

# 办公塔楼
off_spec = [rect_ring(40, 40, 0), rect_ring(40, 40, 62), rect_ring(36, 36, 122),
            rect_ring(34, 34, 132)]
src_loft("offTower", off_spec, tex="tex_glass", uv=[6, 14], rough=0.16, metal=0.7)
w("  Prefab { id: pfOffTower; source: offTower }")
off_pos = [(x, y, terrain_h(x, y)) for (x, y) in
           [(-470, -300), (-600, -180), (470, -280), (610, -160),
            (-430, 300), (520, 340), (-760, 60), (700, 40)]]
instances("instOffTower", "pfOffTower", off_pos)

# 东侧站区配套（长途汽车站 / 停车楼）
w("  // ---------------- 东侧长途汽车站（站台雨棚 + 柱列 + 发车岛）----------------")
box("busHall", 150.0, 118.0, 17.0, [560, -60, 8.5], "#c8c5bd", "tex_conc", [14, 10])
box("busTower", 44.0, 40.0, 30.0, [560, -168, 15.0], "#c2bfb7", "tex_glass", [4, 7])
# 大跨度站台雨棚（低于站房雨棚，形成层次）
box("busCanopy", 210.0, 96.0, 1.4, [546, -240, 15.4], "#dcd9d1", "tex_metal", [42, 20])
src_box("busCol", 1.2, 1.2, 14.6, "#cdcac2", "tex_conc", [1, 6])
w("  Prefab { id: pfBusCol; source: busCol }")
bc = []
for k in range(5):
    for j in range(2):
        bc.append((452.0 + k * 46.0, -196.0 - j * 88.0, 7.3))
instances("instBusCol", "pfBusCol", bc)
# 发车岛（混凝土岛 + 黄线）
src_box("busIsland", 180.0, 4.2, 0.35, "#c4c1b9", "tex_paveL", [22, 1])
w("  Prefab { id: pfBusIsland; source: busIsland }")
instances("instBusIsland", "pfBusIsland",
          [(546.0, -206.0 - j * 30.0, 0.18) for j in range(4)])
box("parkBox", 150.0, 190.0, 26.0, [610, -380, 13.0], "#b9b6ae", "tex_conc", [12, 16])
box("westAid", 150.0, 130.0, 16.0, [-580, -120, 8.0], "#c5c2ba", "tex_conc", [12, 10])
w()

# ---------------- 站区周边城市肌理 ----------------
w("  // ---------------- 周边街区（中层层积，衬托站房尺度）----------------")
block_specs = [
    ("blkA", "tex_conc", [8, 3], "#d2cfc7", 26, 34, 14),
    ("blkB", "tex_glass", [6, 4], "#eef1f3", 30, 30, 30),
    ("blkC", "tex_paveL", [7, 3], "#c6c2b8", 22, 40, 11),
    ("blkD", "tex_metal", [7, 4], "#cfcdc7", 24, 28, 22),
    ("blkE", "tex_conc", [8, 3], "#d8d6d0", 28, 32, 16),
    ("blkF", "tex_conc", [9, 4], "#cbc8c0", 34, 30, 26),
    ("blkG", "tex_glass", [7, 5], "#e6ebee", 26, 26, 42),
    ("blkH", "tex_paveL", [6, 3], "#cfccc4", 20, 36, 9),
    ("blkI", "tex_metal", [8, 4], "#dad8d2", 32, 34, 19),
    ("blkJ", "tex_conc", [7, 4], "#c4c1b9", 24, 24, 34),
]
for key, tex, uv, tint, wx, dy, hz in block_specs:
    sp = [rect_ring(wx, dy, 0), rect_ring(wx, dy, hz), rect_ring(wx - 2, dy - 2, hz + 5)]
    src_loft(key, sp, tex=tex, uv=uv, tint=tint, rough=0.72, metal=0.05)
    w("  Prefab { id: pf_%s; source: %s }" % (key, key))

blk_pos = {k[0]: [] for k in block_specs}
# 街区网格：92 m 柱网（70 m 地块 + 22 m 街道），同时铺出街道面
def fill_blocks(x0, x1, y0, y1, pitch=92.0, tag=""):
    yy = y0
    while yy < y1:
        xx = x0
        while xx < x1:
            cx, cy = xx + 35.0, yy + 35.0
            keep = True
            # 只让开站房/车场本体与南广场，其余尽量贴上来（否则画面两侧全空）
            if abs(cx) < 540 and -250 < cy < 250:
                keep = False
            if abs(cx) < 350 and -545 < cy < -100:
                keep = False
            if abs(abs(cx) - 470) < 26:
                keep = False
            if keep:
                key = block_specs[rng.randrange(len(block_specs))][0]
                blk_pos[key].append((cx + rng.uniform(-4, 4), cy + rng.uniform(-4, 4),
                                     terrain_h(cx, cy)))
            xx += pitch
        yy += pitch
    # 街区底下的街道面（没有它地块就像浮在空地上）
    if not tag:
        return
    RW, RD = x1 - x0, y1 - y0
    ux = max(2, int(RW / 60.0)); uy = max(2, int(RD / 60.0))
    src_box("streetH_" + tag, RW, 20.0, 0.14, "#5f6166", "tex_asph", [ux, 1], rough=0.9)
    w("  Prefab { id: pfStreetH_%s; source: streetH_%s }" % (tag, tag))
    ys = [y0 + k * pitch + 81.0 for k in range(int((y1 - y0) // pitch) + 1)]
    ys = [v for v in ys if y0 + 6.0 < v < y1 - 6.0]
    instances("instStreetH_" + tag, "pfStreetH_" + tag,
              [(x0 + RW / 2.0, v, 0.07) for v in ys])
    src_box("streetV_" + tag, 20.0, RD, 0.14, "#5f6166", "tex_asph", [1, uy], rough=0.9)
    w("  Prefab { id: pfStreetV_%s; source: streetV_%s }" % (tag, tag))
    xs = [x0 + k * pitch + 81.0 for k in range(int((x1 - x0) // pitch) + 1)]
    xs = [v for v in xs if x0 + 6.0 < v < x1 - 6.0]
    instances("instStreetV_" + tag, "pfStreetV_" + tag,
              [(v, y0 + RD / 2.0, 0.07) for v in xs])

fill_blocks(-1700, -700, 260, 640, 76.0, "NW")
fill_blocks(700, 1700, 260, 640, 76.0, "NE")
fill_blocks(-1700, 1700, -1600, -540, 92.0, "S")
fill_blocks(-1700, -540, -540, 300, 92.0, "W")
fill_blocks(540, 1700, -540, 300, 92.0, "E")
for k, v in blk_pos.items():
    instances("inst_" + k, "pf_" + k, v)
w()

# ---------------- 站北绿带（地形由 hills 承载，此处只补植栽与缓坡草坪）----------------
w("  // ---------------- 站前草坪带（地形之上）----------------")
box("northApron", 1250.0, 260.0, 0.16, [0, 250.0, 0.08], "#93a464", "tex_grass", [42, 9])
w()

# 高架路 / 匝道（东西两侧）
for sx, tag in ((-1, "W"), (1, "E")):
    w("  Box { id: ramp%s; width: 15; depth: 620; height: 1.4; position: [%s, -170, 11.0] }"
      % (tag, n(sx * 470)))
    w("  PrincipledMaterial { target: ramp%s; baseColorMap: tex_asph; uvScale: [4, 60];"
      " roughness: 0.88 }" % tag)
    src_box("rampCol" + tag, 1.6, 1.6, 10.0, "#bdbab2", "tex_conc", [1, 4])
    w("  Prefab { id: pfRampCol%s; source: rampCol%s }" % (tag, tag))
    instances("instRampCol" + tag, "pfRampCol" + tag,
              [(sx * 470, -170 + k * 46.0, 5.0) for k in range(14)])
w()
w("}")

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(L) + "\n")

print("wrote %s  %.1f KB  lines=%d" % (OUT, os.path.getsize(OUT) / 1024.0, len(L)))
print("platforms=%d  trees=%d  residential=%d  offices=%d"
      % (PLAT_N, len(treeA) + len(treeB), len(res_pos), len(off_pos)))
