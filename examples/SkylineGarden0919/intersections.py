"""42 intersections: four crosswalks, stop lines and directional signal heads.
Shared signal phases are supplied by the fixed-step traffic simulation.
"""
import math


def build(env):
    Mesh, rgb, js = env['Mesh'], env['rgb'], env['js']
    mesh = Mesh()
    white, asphalt = rgb('eee9cf'), env['road']
    dark, pole = rgb('172127'), rgb('66737a')
    lenses = {(axis, color): [] for axis in range(2) for color in range(3)}
    for x in env['xs']:
        for y in env['ys']:
            vx, hy = (13 if x in (-190, 130) else 10), (13 if y == 40 else 10)
            # Cover the obsolete centre/dashed markings inside the junction.
            mesh.box((x, y, .465), (2*vx, 2*hy+18, .025), asphalt)
            mesh.box((x, y, .465), (2*vx+18, 2*hy, .025), asphalt)
            # Small corner aprons accommodate the outer-lane turning envelope.
            for sx in (-1, 1):
                for sy in (-1, 1):
                    center = (x+sx*vx, y+sy*hy, .479)
                    for i in range(16):
                        a,b = i*math.pi/8,(i+1)*math.pi/8
                        mesh.tri(center,(center[0]+3.5*math.cos(a),center[1]+3.5*math.sin(a),.479),(center[0]+3.5*math.cos(b),center[1]+3.5*math.sin(b),.479),asphalt)
            for axis in range(2):
                lane_half, cross_half = (vx, hy) if axis == 0 else (hy, vx)
                for sign in (-1, 1):
                    # Heading is toward the junction; right-hand traffic lane.
                    d = (0, sign) if axis == 0 else (sign, 0)
                    right = (d[1], -d[0])
                    def point(side, forward, z):
                        return (x+right[0]*side+d[0]*forward, y+right[1]*side+d[1]*forward, z)
                    yaw = math.atan2(right[1], right[0])
                    for j in range(int((2*lane_half-2)/2)):
                        side = -lane_half+2+j*2
                        mesh.box(point(side, -cross_half-4, .505), (1.0, 4, .035), white, yaw)
                    mesh.box(point(lane_half/2, -cross_half-8.5, .505), (lane_half-1, .55, .035), white, yaw)
                    # Pole on the approach sidewalk, cantilever over the lane.
                    base = point(lane_half+1.8, -cross_half-7, .42)
                    top = point(lane_half+1.8, -cross_half-7, 7.8)
                    lane = lane_half*.75
                    head = point(lane, -cross_half-7, 7.8)
                    mesh.beam(base, top, .16, pole, n=8)
                    mesh.beam(top, head, .13, pole, n=8)
                    mesh.box(point(lane, -cross_half-7, 6.95), (.92, .48, 2.35), dark, yaw)
                    for color, z in enumerate((7.68, 6.97, 6.26)):
                        # Flattened spheres face approaching traffic, not both ways.
                        p = point(lane, -cross_half-7.30, z)
                        lenses[axis, color].append((p, math.degrees(yaw)))
                        mesh.ellipsoid(p, (.29 if axis == 0 else .08, .08 if axis == 0 else .29, .29), rgb('293130'), n=8, k=4)
    mesh.save('junctions')
    lines = ['property real phase: 0', env['model']('markingsAndPoles', 'junctions')]
    colors = [('red', '#ff3424', '[8,0.08,0.03]'), ('amber', '#ffbd25', '[7,3.2,0.04]'), ('green', '#33ff8e', '[0.05,6,1.3]')]
    # 0 NS green, 1 NS amber, 2 all red, 3 EW green, 4 EW amber, 5 all red.
    for axis in range(2):
        for color, (name, base, emission) in enumerate(colors):
            tag = f'{"ns" if axis == 0 else "ew"}{name}'
            active = (f'phase !== {axis*3} && phase !== {axis*3+1}' if color == 0 else f'phase === {axis*3+(1 if color == 1 else 0)}')
            lines += [f'Sphere {{ id: {tag}; radius: 0.30; segments: 12; visible: false; UnlitMaterial {{ baseColor: "{base}"; emissiveColor: {emission}; opacity: {active} ? 1 : 0 }} }}',
                      f'Prefab {{ id: {tag}Prefab; source: {tag} }}',
                      f'Instances {{ id: {tag}Lenses; prefab: {tag}Prefab; positions: {js([p for p,a in lenses[axis,color]])}; rotations_z: {js([a for p,a in lenses[axis,color]])}; scale: [1,0.30,1] }}']
    env['write']('Intersections', lines)
    print('Junctions: 42; crosswalks: 168; signal heads: 168')
