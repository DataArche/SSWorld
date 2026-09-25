"""Window-only night material layers, aligned to the original building meshes.

Plan: reusable native panes in batches, deterministic occupied rooms, shared
warm materials, and opacity driven by the existing dawn/dusk lighting clock.
"""
import math
import random
from collections import defaultdict


def build(env):
    rng = random.Random(9192026)
    rows = defaultdict(list)

    def pane(p, size, yaw=0, probability=.20):
        if rng.random() > probability:
            return
        tone = rng.choices(range(3), [5, 3, 2])[0]
        rows[tone].append(([round(v, 4) for v in p],
                           [round(v, 4) for v in size], round(yaw, 4)))

    for name, buildings in env['groups'].items():
        k = int(name[-1])
        for origin, angle, scale in buildings:
            def local(p, size, yaw=0, probability=.20):
                pane([origin[i] + p[i]*scale[i] for i in range(3)],
                     [size[0]*scale[0 if yaw == 0 else 1], 1,
                      size[2]*scale[2]], yaw, probability)
            if name.startswith('tower'):
                for z in range(12, 100, 4):
                    tier = min(2, (z-8)//29) if k == 3 else 0
                    ww, dd, xx = (34-tier*6, 32-tier*5, tier*2) if k == 3 else (30, 30, 0)
                    for x in range(-12, 13, 4):
                        if abs(x-xx) < ww/2-1:
                            for side in (-1, 1):
                                local((x, side*(dd/2+.23), z+1.9), (2.7, 1, 2.3))
            else:
                w, d, h = 22+(k % 2)*6, 22, [12, 18, 25, 10, 16, 22][k]
                for z in range(3, h, 4):
                    for x in range(-int(w/2)+3, int(w/2), 5):
                        for side in (-1, 1):
                            local((x, side*(d/2+.25), z), (2.8, 1, 1.8), probability=.16)
                    for y in range(-8, 9, 5):
                        for side in (-1, 1):
                            local((side*(w/2+.25), y, z), (2.8, 1, 1.8), 90, .16)

    # Curtain-wall rooms follow the same tapered/twisted rings as the landmarks.
    for rounded, origin in [(False, (87, 157, .5)), (True, (-147, 243, .5))]:
        h, n = (218, 32) if rounded else (248, 4)
        def ring(z):
            t = z/h
            a = 0 if rounded else t*.25
            rx, ry = (25 if rounded else 29)*(1-.26*t), (20 if rounded else 25)*(1-.12*t)
            return [(rx*math.cos(i*2*math.pi/n+a), ry*math.sin(i*2*math.pi/n+a)) for i in range(n)]
        for z in range(12, h-4, 4):
            r = ring(z+2)
            for i in range(n):
                a, b = r[i], r[(i+1) % n]
                dx, dy = b[0]-a[0], b[1]-a[1]
                length = math.hypot(dx, dy)
                count = 1 if rounded else 9
                for j in range(count):
                    t = (j+.5)/count
                    p = [origin[0]+a[0]+dx*t+dy/length*.23,
                         origin[1]+a[1]+dy*t-dx/length*.23, origin[2]+z+2]
                    pane(p, [length/count*.72, 1, 2.5], math.degrees(math.atan2(dy, dx)), .20)

    lines = ['property real level: 0']
    colors = [('#ffe2af', '[3,2.05,1.05]'), ('#fff1d5', '[2.4,2.15,1.7]'), ('#d5e8f4', '[1.4,1.8,2.2]')]
    total = 0
    for tone, panes in rows.items():
        color, emission = colors[tone]
        for start in range(0, len(panes), 2048):
            subset = panes[start:start+2048]
            tag = f'room{tone}_{start//2048}'
            lines += [f'Box {{ id: {tag}; width: 1; depth: 0.05; height: 1; visible: false; UnlitMaterial {{ baseColor: "{color}"; emissiveColor: {emission}; opacity: level }} }}',
                      f'Prefab {{ id: {tag}Prefab; source: {tag} }}']
            for offset in range(0, len(subset), 480):
                batch = subset[offset:offset+480]
                js = env['js']
                lines.append(f'Instances {{ id: {tag}Batch{offset}; prefab: {tag}Prefab; positions: {js([r[0] for r in batch])}; scales: {js([r[1] for r in batch])}; rotations_z: {js([r[2] for r in batch])} }}')
            total += len(subset)
    env['write']('WindowGlow', lines)
    print(f'Night windows: {total} occupied panes, {len(rows)} material tones')
