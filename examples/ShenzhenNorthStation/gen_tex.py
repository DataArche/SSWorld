#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ShenzhenNorthStation / gen_tex.py
=================================================================
程序化生成深圳北站场景所需的全部贴图（纯 zlib 手写 PNG）。

  roof_grid / roof_grid_n   主站房白色格栅屋面（含法线浮雕）—— 全场标志性元素
  canopy_rib / _n           站台雨棚白色肋条屋面
  pave_light / pave_dark    广场浅色花岗岩铺装 / 车行道深色铺装
  sign_main                 "深圳北站 SHENZHEN NORTH RAILWAY STATION" 标识（系统字体烧制）
  resid_stripe              西侧住宅群橙白横条纹立面
  glass_tower               周边塔楼玻璃幕墙
  concrete / metal_panel    混凝土 / 金属板
  skylight                  下沉庭院玻璃采光顶
  surf_leaf / surf_grass / surf_treebark

尺寸与 UV 约定见 README.md。
"""
import math
import os
import struct
import subprocess
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")


# ---------------------------------------------------------------- PNG 写出
def write_png(path, width, height, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def hashf(*seeds):
    """确定性伪随机 [0,1)。"""
    x = 0x2545F491
    for s in seeds:
        x = (x ^ (int(s) * 2654435761)) & 0xFFFFFFFF
        x = (x * 1103515245 + 12345) & 0x7FFFFFFF
        x ^= x >> 13
    return ((x >> 8) & 0xFFFF) / 65536.0


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def hexc(s):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def clamp8(c):
    return tuple(int(max(0, min(255, v))) for v in c)


# ---------------------------------------------------------------- 法线图
def normal_map(size, hfun, strength=2.0, out=None):
    """由高度函数用中心差分生成切线空间法线图（+Y up，OpenGL/glTF 约定）。"""
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            hl = hfun((x - 1) % size, y)
            hr = hfun((x + 1) % size, y)
            hd = hfun(x, (y - 1) % size)
            hu = hfun(x, (y + 1) % size)
            nx = (hl - hr) * strength
            ny = (hd - hu) * strength
            nz = 1.0
            inv = 1.0 / math.sqrt(nx * nx + ny * ny + nz * nz)
            nx *= inv
            ny *= inv
            nz *= inv
            row += [int((nx * 0.5 + 0.5) * 255),
                    int((ny * 0.5 + 0.5) * 255),
                    int((nz * 0.5 + 0.5) * 255)]
        rows.append(row)
    write_png(out, size, size, rows)
    return out


# ---------------------------------------------------------------- 屋面格栅
ROOF_CELL = 32          # 每格像素
ROOF_N = 16             # 16×16 格 / 张
ROOF_SIZE = ROOF_CELL * ROOF_N   # 512


def roof_cellbase():
    return hexc("#eceae3")


def roof_albedo():
    """主站房屋面：细密方格 + 每 4 格一道大分缝 + 每格微差。"""
    base = roof_cellbase()
    rows = []
    for y in range(ROOF_SIZE):
        row = []
        cx, cy = x_cell = y // ROOF_CELL, 0
        for x in range(ROOF_SIZE):
            i, j = x // ROOF_CELL, y // ROOF_CELL
            fx, fy = x % ROOF_CELL, y % ROOF_CELL
            v = hashf(i * 7 + 1, j * 13 + 5)
            col = mix(base, (255, 255, 255), 0.03 + 0.14 * v)
            # 格缝：2 px（= 0.25 m，实拍格栅缝量级），太细在远景会糊掉
            if fx < 2 or fy < 2:
                col = mix(col, hexc("#a9a79f"), 0.90)
            elif fx == 2 or fy == 2:
                col = mix(col, hexc("#c6c4bc"), 0.55)
            # 大分缝
            if i % 4 == 0 and fx < 3:
                col = mix(col, hexc("#93918a"), 0.88)
            if j % 4 == 0 and fy < 3:
                col = mix(col, hexc("#93918a"), 0.88)
            # 轻微污渍
            d = hashf(i * 31, j * 17) 
            if d > 0.88:
                col = mix(col, hexc("#d8d5cc"), 0.4)
            row += clamp8(col)
        rows.append(row)
    return rows


def roof_height(x, y):
    fx, fy = x % ROOF_CELL, y % ROOF_CELL
    i, j = x // ROOF_CELL, y // ROOF_CELL
    h = 0.0
    if fx < 2 or fy < 2:
        h -= 0.55                      # 格缝下凹
    if (i % 4 == 0 and fx < 3) or (j % 4 == 0 and fy < 3):
        h -= 0.25                      # 大分缝再深一点
    # 板面微起伏
    h += 0.05 * math.sin(x * 0.31) * math.cos(y * 0.27)
    return h


# ---------------------------------------------------------------- 雨棚肋条
RIB_SIZE = 256
RIB_PITCH = 8


def rib_albedo():
    base = hexc("#e7e6e1")
    rows = []
    for y in range(RIB_SIZE):
        row = []
        for x in range(RIB_SIZE):
            fx = x % RIB_PITCH
            long_i = x // RIB_PITCH
            col = mix(base, (255, 255, 255), 0.06 * hashf(long_i * 3))
            if fx < 1:
                col = mix(col, hexc("#c2c0b9"), 0.8)
            elif fx == 1:
                col = mix(col, hexc("#d5d3cc"), 0.55)
            elif fx == RIB_PITCH - 1:
                col = mix(col, hexc("#f6f5f1"), 0.5)
            # 横向分段缝
            if y % 64 < 1:
                col = mix(col, hexc("#c8c6bf"), 0.7)
            row += clamp8(col)
        rows.append(row)
    return rows


def rib_height(x, y):
    fx = x % RIB_PITCH
    t = math.sin(math.pi * (fx / float(RIB_PITCH)))
    h = 0.7 * t
    if y % 64 < 1:
        h -= 0.3
    return h


# ---------------------------------------------------------------- 铺装
def pave_albedo(size=512, slab=64, light="#c9c7c0", dark="#a5a39c",
                joint="#8e8c86", band=False):
    L, D, J = hexc(light), hexc(dark), hexc(joint)
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            i, j = x // slab, y // slab
            fx, fy = x % slab, y % slab
            v = hashf(i * 11 + 3, j * 19 + 7)
            col = mix(L, D, 0.30 * v)
            if band and ((i + j) % 7 == 0):
                col = mix(col, D, 0.45)
            # 细颗粒
            g = hashf(x * 3 + 1, y * 5 + 2)
            col = mix(col, (255, 255, 255), 0.05 * g)
            if fx < 1 or fy < 1:
                col = mix(col, J, 0.85)
            elif fx == 1 or fy == 1:
                col = mix(col, J, 0.35)
            row += clamp8(col)
        rows.append(row)
    return rows


def asphalt_albedo(size=256):
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            n1 = hashf(x * 131 + 7, y * 977 + 3)
            n2 = hashf(x * 61 + 991, y * 313 + 17)
            col = mix((58, 60, 64), (98, 101, 106), 0.6 * n1 + 0.4 * n2)
            if n2 > 0.94:
                col = mix(col, (120, 122, 126), 0.5)
            row += clamp8(col)
        rows.append(row)
    return rows


def concrete_albedo(size=256, base="#d6d3cb"):
    B = hexc(base)
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            n = hashf(x * 29 + 5, y * 71 + 11)
            col = mix(B, (255, 255, 255), 0.06 * n)
            # 模板缝
            if y % 128 < 1:
                col = mix(col, hexc("#b6b3ab"), 0.5)
            if x % 128 < 1:
                col = mix(col, hexc("#b6b3ab"), 0.35)
            # 水渍
            if n < 0.10:
                col = mix(col, hexc("#bfbcb4"), 0.45)
            row += clamp8(col)
        rows.append(row)
    return rows


def metal_albedo(size=256):
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            n = hashf(x * 7 + 13, y * 23 + 29)
            col = mix(hexc("#b9bcc0"), hexc("#d3d6da"), n)
            # 板缝
            if x % 64 < 1 or y % 64 < 1:
                col = mix(col, hexc("#8f9296"), 0.7)
            row += clamp8(col)
        rows.append(row)
    return rows


# ---------------------------------------------------------------- 玻璃
def glass_albedo(size=256, tint="#5c7286", mull="#8d959c"):
    T, M = hexc(tint), hexc(mull)
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            i, j = x // 32, y // 32
            v = hashf(i * 17 + 2, j * 41 + 9)
            col = mix(T, (150, 178, 198), 0.28 * v)
            # 层间带
            if y % 32 < 5:
                col = mix(col, hexc("#9aa0a5"), 0.55)
            if x % 32 < 1:
                col = mix(col, M, 0.75)
            row += clamp8(col)
        rows.append(row)
    return rows


def skylight_albedo(size=256):
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            i, j = x // 42, y // 42
            v = hashf(i * 13 + 5, j * 7 + 3)
            col = mix(hexc("#2b3a44"), hexc("#4d6a7c"), 0.45 * v)
            if x % 42 < 3 or y % 42 < 3:
                col = mix(col, hexc("#8e969b"), 0.8)
            # 反射天空的斜向亮带
            s = (x + y) % 170
            if s < 26:
                col = mix(col, hexc("#9fc3d8"), 0.35)
            row += clamp8(col)
        rows.append(row)
    return rows


# ---------------------------------------------------------------- 住宅条纹
def resid_albedo(size=256):
    """西侧住宅群：橙白横条纹 + 窗带。"""
    O, W = hexc("#c8683a"), hexc("#efe9df")
    rows = []
    for y in range(size):
        row = []
        band = (y // 16) % 2              # 16px 一条，橙白交替
        for x in range(size):
            base = O if band == 0 else W
            col = base
            if band == 0:
                # 橙色条内嵌窗洞
                if (x % 24) < 13 and (y % 16) > 3:
                    col = mix(hexc("#3d4a55"), base, 0.25)
                elif (x % 24) < 15:
                    col = mix(col, (255, 255, 255), 0.18)
            else:
                # 白色条内的窗下墙
                if (x % 24) < 13:
                    col = mix(col, hexc("#f6f3ec"), 0.5)
                if y % 16 < 2:
                    col = mix(col, hexc("#b9b3a8"), 0.45)
            n = hashf(x * 5 + 1, y * 3 + 7)
            col = mix(col, (255, 255, 255), 0.05 * n)
            row += clamp8(col)
        rows.append(row)
    return rows


# ---------------------------------------------------------------- 广场大板铺装
def plaza_albedo(size=512):
    """广场花岗岩大板：3 m 板 + 每 8 板一道宽石带 + 板间色差（实拍广场最显眼的特征）。"""
    SLAB = 32                     # 32 px == 3 m
    B = hexc("#c9c7bf")
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            i, j = x // SLAB, y // SLAB
            fx, fy = x % SLAB, y % SLAB
            v = hashf(i * 11 + 3, j * 19 + 7)
            col = mix(B, hexc("#a9a79f"), 0.34 * v)
            # 每 8 板一道深色石带（宽 0.6 m）
            band = (i % 8 == 0) or (j % 8 == 0)
            if band:
                col = mix(col, hexc("#8d8b85"), 0.70)
            # 板缝
            elif fx < 1 or fy < 1:
                col = mix(col, hexc("#9c9a93"), 0.75)
            # 石材细颗粒
            g = hashf(x * 3 + 1, y * 5 + 2)
            col = mix(col, (255, 255, 255), 0.05 * g)
            row += clamp8(col)
        rows.append(row)
    return rows


# ---------------------------------------------------------------- 植被
def leaf_albedo(size=128):
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            n1 = hashf(x * 131 + 7, y * 977 + 3)
            n2 = hashf(x * 61 + 991, y * 313 + 17)
            n3 = hashf((x // 4) * 17, (y // 4) * 29)
            t = 0.45 * n1 + 0.35 * n3 + 0.20 * n2
            col = mix((12, 28, 10), (48, 92, 32), t)
            if n2 > 0.87:
                col = mix(col, (74, 126, 50), 0.6)
            if n1 < 0.12:
                col = mix(col, (5, 12, 5), 0.7)
            row += clamp8(col)
        rows.append(row)
    return rows


def grass_albedo(size=128):
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            n1 = hashf(x * 131 + 7, y * 977 + 3)
            n3 = hashf((x // 4) * 17, (y // 4) * 29)
            col = mix((40, 62, 24), (92, 122, 52), 0.5 * n1 + 0.5 * n3)
            if hashf(x * 61, y * 313) > 0.9:
                col = mix(col, (122, 150, 74), 0.45)
            row += clamp8(col)
        rows.append(row)
    return rows


def forest_albedo(size=128):
    """远山植被：中明度橄榄绿 + 林斑（比近景树叶亮，才不会被雾压成黑块）。"""
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            n1 = hashf(x * 131 + 7, y * 977 + 3)
            n2 = hashf(x * 61 + 991, y * 313 + 17)
            n3 = hashf((x // 6) * 17, (y // 6) * 29)
            t = 0.45 * n1 + 0.35 * n3 + 0.20 * n2
            col = mix((62, 80, 46), (124, 146, 90), t)
            if n2 > 0.90:
                col = mix(col, (146, 166, 110), 0.5)
            if n1 < 0.10:
                col = mix(col, (42, 56, 34), 0.6)
            row += clamp8(col)
        rows.append(row)
    return rows


# ---------------------------------------------------------------- 标识
SIGN_PS1 = r'''
Add-Type -AssemblyName System.Drawing
$out   = "{out}"
$outfx = "{outfx}"
$outfy = "{outfy}"
$outr  = "{outr}"
$W = 1536; $H = 512
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::FromArgb(255, 236, 234, 227))
$red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 190, 32, 40))
$fCJK = New-Object System.Drawing.Font("Microsoft YaHei", 190, [System.Drawing.FontStyle]::Bold)
$fEN  = New-Object System.Drawing.Font("Arial", 52, [System.Drawing.FontStyle]::Regular)
$sz = $g.MeasureString("深圳北站", $fCJK)
$g.DrawString("深圳北站", $fCJK, $red, [float](($W - $sz.Width) / 2), [float]36)
$sz2 = $g.MeasureString("SHENZHEN NORTH RAILWAY STATION", $fEN)
$g.DrawString("SHENZHEN NORTH RAILWAY STATION", $fEN, $red, [float](($W - $sz2.Width) / 2), [float]320)
$g.Dispose()
# 朝向实测结论（并排对照，一次读出）：
#   Plane 的贴图在 +Z 侧可见，-Z 侧被背面剔除 → 标识板必须用 qx(64) 朝向；
#   UV 相对"直立正读"是【垂直翻转】的 → 贴图先做一次 FlipY 才是正的。
#   （同场对照：FlipX 版整体倒置，FlipY 版正读。）
$bmp.RotateFlip([System.Drawing.RotateFlipType]::RotateNoneFlipY)
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
'''


def render_sign():
    out = os.path.join(ASSETS, "sign_main.png")
    ps = SIGN_PS1.replace("{out}", out.replace("\\", "\\\\"))
    script = os.path.join(HERE, "_sign_tmp.ps1")
    # 必须带 BOM：powershell.exe 对无 BOM 的 .ps1 会按系统 ANSI 代码页解码，
    # 中文字符串会被解成别的字（表现为"标识文字是乱码"，而英文正常）。
    with open(script, "w", encoding="utf-8-sig") as f:
        f.write(ps)
    try:
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                        "-File", script], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return out
    finally:
        if os.path.exists(script):
            os.remove(script)


# ---------------------------------------------------------------- 主流程
def main():
    if not os.path.isdir(ASSETS):
        os.makedirs(ASSETS)
    made = []

    def w(name, size, rows):
        p = os.path.join(ASSETS, name)
        write_png(p, size, size, rows)
        made.append(p)

    w("roof_grid.png", ROOF_SIZE, roof_albedo())
    normal_map(ROOF_SIZE, roof_height, 1.4,
               os.path.join(ASSETS, "roof_grid_n.png"))
    made.append(os.path.join(ASSETS, "roof_grid_n.png"))

    w("canopy_rib.png", RIB_SIZE, rib_albedo())
    normal_map(RIB_SIZE, rib_height, 1.8, os.path.join(ASSETS, "canopy_rib_n.png"))
    made.append(os.path.join(ASSETS, "canopy_rib_n.png"))

    w("pave_light.png", 512, pave_albedo(512, 64, "#cbc9c2", "#a8a69f", "#8f8d87", True))
    w("plaza_pave.png", 512, plaza_albedo())
    w("pave_dark.png", 512, pave_albedo(512, 48, "#8d8b86", "#6e6c68", "#5b5955", False))
    w("asphalt.png", 256, asphalt_albedo())
    w("concrete.png", 256, concrete_albedo())
    w("metal_panel.png", 256, metal_albedo())
    w("glass_tower.png", 256, glass_albedo())
    w("skylight.png", 256, skylight_albedo())
    w("resid_stripe.png", 256, resid_albedo())
    w("surf_leaf.png", 128, leaf_albedo())
    w("surf_grass.png", 128, grass_albedo())
    w("hill_forest.png", 128, forest_albedo())

    sign = render_sign()
    made.append(sign)

    for p in made:
        print("%-28s %7.1f KB" % (os.path.basename(p), os.path.getsize(p) / 1024.0))
    print("total %d files" % len(made))


if __name__ == "__main__":
    main()
