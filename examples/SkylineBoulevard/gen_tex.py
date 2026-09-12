#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SkylineBoulevard / gen_tex.py
=================================================================
程序化生成幕墙贴图（纯 zlib 手写 PNG，不依赖 PIL）。

Loft 建筑的 UV 约定（SSDL 0.3）：
  u = 沿环一周 0..1，v = 沿 sections 顺序 0..1。
  "band"  每个楼层带 4 环 → 一环带占 v 的 1/4 段：
      v∈[0.00,0.25) 玻璃竖面   v∈[0.25,0.50) 楼板下水平面
      v∈[0.50,0.75) 楼板竖面   v∈[0.75,1.00) 楼板上水平面
  "strip" 每个楼层带 3 环 → 一环带占 v 的 1/3 段：
      v∈[0,1/3) 外倾玻璃面   v∈[1/3,2/3) 内凹玻璃面   v∈[2/3,1) 层线水平板

同时输出 metallicRoughness 贴图（线性空间：G=粗糙度、B=金属度），
这样同一张立面里玻璃可以又亮又镜面、楼板又哑又粗糙。
"""
import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
SIZE = 256
BAYS = 8               # 横向窗格数
BAY_PX = SIZE // BAYS


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


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def hexc(s):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def jitter(seed):
    """确定性伪随机 [0,1)：线性同余，保证每次生成同图。"""
    x = (seed * 1103515245 + 12345) & 0x7FFFFFFF
    x = (x ^ (x >> 13)) * 2654435761 & 0x7FFFFFFF
    return ((x >> 8) & 0xFFFF) / 65536.0


# ---------------------------------------------------------------- 立面风格
# glass / slab / frame / mullion 都是 sRGB 基色
STYLES = {
    "glassblue": dict(glass="#54697e", slab="#bcb7ab", frame="#7d8c9a",
                      gvar=("#40566a", "#93b4cc"), rough=(0.10, 0.72),
                      metal=(0.88, 0.04), lit="#e8d9a8", lit_p=0.18),
    "glassdark": dict(glass="#414c58", slab="#96938a", frame="#59636e",
                      gvar=("#2c353e", "#6b7c8b"), rough=(0.08, 0.68),
                      metal=(0.92, 0.06), lit="#d8c489", lit_p=0.12),
    "glassteal": dict(glass="#5d8285", slab="#c6bda6", frame="#88a3a4",
                      gvar=("#456867", "#a3c6c7"), rough=(0.12, 0.70),
                      metal=(0.85, 0.05), lit="#f0e2b6", lit_p=0.15),
    "panel": dict(glass="#6e7883", slab="#c8c4bb", frame="#9aa0a6",
                  gvar=("#59636d", "#a8b4be"), rough=(0.22, 0.62),
                  metal=(0.42, 0.03), lit="#efe4c4", lit_p=0.22),
    "stone": dict(glass="#5d6a72", slab="#b2a78e", frame="#a99b80",
                  gvar=("#4b5860", "#95a7b0"), rough=(0.18, 0.80),
                  metal=(0.30, 0.02), lit="#e6d7ad", lit_p=0.14),
}


def band_pixels(st, size=SIZE):
    """band 风格：v 四等分。"""
    g = hexc(st["glass"]); s = hexc(st["slab"]); f = hexc(st["frame"])
    gv0 = hexc(st["gvar"][0]); gv1 = hexc(st["gvar"][1]); lit = hexc(st["lit"])
    r_lo, r_hi = st["rough"]; m_lo, m_hi = st["metal"]
    albedo, mr = [], []
    q = size // 4
    for y in range(size):
        rowA, rowM = [], []
        for x in range(size):
            bay = x // BAY_PX
            bx = x % BAY_PX
            quarter = y // q
            ly = (y % q) / float(q - 1)
            j1 = jitter(bay * 7 + 3)
            j2 = jitter(bay * 13 + 11)
            if quarter == 0:
                # 玻璃竖面：底部略暗（楼板投影），带竖向中梃
                col = mix(gv0, gv1, j1 * 0.85)
                if j2 < st["lit_p"]:
                    col = mix(col, lit, 0.55 + 0.35 * j1)      # 室内灯/窗帘
                col = mix(col, g, 0.35)
                col = mix(col, (30, 36, 44), 0.20 * (1.0 - ly))  # 顶部进光更多
                if bx < 2:
                    col = mix(col, f, 0.85)                    # 竖向中梃
                elif bx == BAY_PX - 1:
                    col = mix(col, f, 0.45)
                if 0.46 * q < (y % q) < 0.54 * q:
                    col = mix(col, f, 0.35)                    # 横向横梃
                a = tuple(int(max(0, min(255, c))) for c in col)
                rr = r_lo + (r_hi - r_lo) * 0.06
                mm = m_hi + (m_lo - m_hi) * 0.92
            elif quarter == 1:
                # 楼板下沿（水平面，几乎看不见）：中性灰
                a = tuple(int(c) for c in mix(s, (40, 42, 46), 0.55))
                rr, mm = r_hi, m_hi
            elif quarter == 2:
                # 楼板竖面：浅色带 + 顶部一条阴影
                col = mix(s, (255, 255, 255), 0.03 * j1)
                col = mix((30, 32, 36), col, 0.55 + 0.45 * min(1.0, ly * 3.0))
                if bx < 1:
                    col = mix(col, (120, 118, 112), 0.35)
                a = tuple(int(max(0, min(255, c))) for c in col)
                rr, mm = r_hi, m_hi
            else:
                # 楼板上沿：最亮
                col = mix(s, (150, 148, 142), 0.55 + 0.05 * j1)
                a = tuple(int(max(0, min(255, c))) for c in col)
                rr, mm = r_hi, m_hi
            rowA += list(a)
            rowM += [0, int(max(0, min(255, rr * 255))), int(max(0, min(255, mm * 255)))]
        albedo.append(rowA)
        mr.append(rowM)
    return albedo, mr


def strip_pixels(st, size=SIZE):
    """strip 风格：v 三等分。"""
    g = hexc(st["glass"]); s = hexc(st["slab"]); f = hexc(st["frame"])
    gv0 = hexc(st["gvar"][0]); gv1 = hexc(st["gvar"][1]); lit = hexc(st["lit"])
    r_lo, r_hi = st["rough"]; m_lo, m_hi = st["metal"]
    albedo, mr = [], []
    q = size // 3
    for y in range(size):
        rowA, rowM = [], []
        for x in range(size):
            bay = x // BAY_PX
            bx = x % BAY_PX
            third = min(2, y // q)
            ly = (y % q) / float(q - 1)
            j1 = jitter(bay * 7 + 3)
            j2 = jitter(bay * 13 + 11)
            if third < 2:
                col = mix(gv0, gv1, j1 * 0.85)
                if j2 < st["lit_p"]:
                    col = mix(col, lit, 0.5 + 0.35 * j1)
                col = mix(col, g, 0.35)
                if third == 1:
                    col = mix(col, (16, 20, 26), 0.22)         # 内凹面更暗
                if bx < 2:
                    col = mix(col, f, 0.85)
                elif bx == BAY_PX - 1:
                    col = mix(col, f, 0.40)
                if third == 1 and ly < 0.10:
                    col = mix(col, s, 0.55)                    # 层线处的窗台板
                a = tuple(int(max(0, min(255, c))) for c in col)
                rr = r_lo + (r_hi - r_lo) * 0.06
                mm = m_hi + (m_lo - m_hi) * 0.92
            else:
                col = mix(s, (150, 148, 142), 0.55 + 0.05 * j1)
                col = mix(col, (34, 36, 40), 0.45 * (1.0 - min(1.0, ly * 4.0)))
                a = tuple(int(max(0, min(255, c))) for c in col)
                rr, mm = r_hi, m_hi
            rowA += list(a)
            rowM += [0, int(max(0, min(255, rr * 255))), int(max(0, min(255, mm * 255)))]
        albedo.append(rowA)
        mr.append(rowM)
    return albedo, mr


def surf_pixels(kind, size=128):
    """地表/植被类平铺贴图：树冠、沥青、草地、铺装。"""
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            n1 = jitter(x * 131 + y * 977 + 7)
            n2 = jitter(x * 61 + y * 313 + 991)
            n3 = jitter((x // 4) * 17 + (y // 4) * 29 + 5)
            if kind == "leaf":
                t = 0.45 * n1 + 0.35 * n3 + 0.20 * n2
                col = mix((10, 26, 8), (46, 88, 30), t)
                if n2 > 0.87:
                    col = mix(col, (70, 120, 48), 0.6)
                if n1 < 0.12:
                    col = mix(col, (4, 10, 4), 0.7)
            elif kind == "asphalt":
                t = 0.6 * n1 + 0.4 * n2
                col = mix((40, 42, 46), (84, 87, 92), t)
                if n3 > 0.93:
                    col = mix(col, (104, 106, 110), 0.5)
            elif kind == "grass":
                t = 0.5 * n1 + 0.5 * n3
                col = mix((32, 52, 20), (78, 108, 44), t)
                if n2 > 0.9:
                    col = mix(col, (112, 140, 68), 0.45)
            elif kind == "pavement":
                gx = (x % 32) < 1
                gy = (y % 32) < 1
                t = 0.6 * n1 + 0.4 * n3
                col = mix((110, 107, 100), (154, 151, 142), t)
                if gx or gy:
                    col = mix(col, (70, 68, 64), 0.75)
            else:
                col = (128, 128, 128)
            row += [int(max(0, min(255, c))) for c in col]
        rows.append(row)
    return rows


def main():
    if not os.path.isdir(ASSETS):
        os.makedirs(ASSETS)
    made = []
    for kind in ("leaf", "asphalt", "grass", "pavement"):
        p = os.path.join(ASSETS, "surf_%s.png" % kind)
        write_png(p, 128, 128, surf_pixels(kind))
        made.append(p)
    for name, st in STYLES.items():
        a, m = band_pixels(st)
        p1 = os.path.join(ASSETS, "facade_band_%s.png" % name)
        p2 = os.path.join(ASSETS, "facade_band_%s_mr.png" % name)
        write_png(p1, SIZE, SIZE, a)
        write_png(p2, SIZE, SIZE, m)
        made += [p1, p2]
        a, m = strip_pixels(st)
        p1 = os.path.join(ASSETS, "facade_strip_%s.png" % name)
        p2 = os.path.join(ASSETS, "facade_strip_%s_mr.png" % name)
        write_png(p1, SIZE, SIZE, a)
        write_png(p2, SIZE, SIZE, m)
        made += [p1, p2]
    for p in made:
        print("%-52s %6.1f KB" % (os.path.basename(p), os.path.getsize(p) / 1024.0))
    print("total %d files" % len(made))


if __name__ == "__main__":
    main()
