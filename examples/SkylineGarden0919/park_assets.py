"""Original park furniture and animation meshes, called by generate.py."""
import math

def build(env):
    Mesh,rgb,write,batch,strip = [env[k] for k in ('Mesh','rgb','write','batch','strip')]
    pi=math.pi; sin=math.sin; cos=math.cos
    centers=[(p['x'],p['y']) for p in env['lots'] if p['type']=='park']
    stone=rgb('e2d8bd'); wood=rgb('af794d'); dark=rgb('40534c')
    m=Mesh()
    # Ring promenade and four accessible entrances; all surfaces clear the lawn.
    strip(m,[(45*cos(i*pi/64),45*sin(i*pi/64),.48) for i in range(129)],6,stone)
    for a in (0,pi/2,pi,3*pi/2):
        strip(m,[(r*cos(a),r*sin(a),.49) for r in (15,66)],5,stone)
    m.box((0,0,.43),(32,32,.18),rgb('d4c7a8'))
    # Circular basin, stone coping and turquoise tiled floor.
    m.beam((0,0,.48),(0,0,.65),10.8,rgb('65776b'),n=64)
    for i in range(64):
        a=i*pi/32;b=(i+1)*pi/32
        m.beam((10.7*cos(a),10.7*sin(a),.9),(10.7*cos(b),10.7*sin(b),.9),.55,stone,n=6)
    m.beam((0,0,.65),(0,0,1.2),1.3,stone,n=24)
    # Eight inward facing slatted benches with bins and small garden lights.
    for i in range(8):
        a=(i+.5)*pi/4;x,y=36*cos(a),36*sin(a);yaw=a+pi/2
        for j in range(4):m.box((x+(j-1.5)*.18*cos(a),y+(j-1.5)*.18*sin(a),1.0),(3,.14,.13),wood,yaw)
        m.box((x+.4*cos(a),y+.4*sin(a),1.45),(3,.16,.75),wood,yaw)
        for sign in (-1,1):m.box((x+sign*cos(yaw),y+sign*sin(yaw),.72),(.16,.6,.55),dark,yaw)
        bx,by=39*cos(a+.11),39*sin(a+.11)
        m.beam((bx,by,.5),(bx,by,1.35),.4,dark,n=8)
        lx,ly=50*cos(a),50*sin(a)
        m.beam((lx,ly,.4),(lx,ly,3.6),.1,dark)
        m.ellipsoid((lx,ly,3.75),(.35,.35,.4),rgb('fff3c9'))
    # Four raised perennial beds away from the walking loops.
    for a in (pi/4,3*pi/4,5*pi/4,7*pi/4):
        x,y=26*cos(a),26*sin(a)
        m.box((x,y,.72),(9,5,.5),stone,a)
        m.box((x,y,1),(8.6,4.6,.12),rgb('456f3c'),a)
        for j in range(28):
            u=(j%7-3)*1.15;v=(j//7-1.5)*1.0
            px=x+u*cos(a)-v*sin(a);py=y+u*sin(a)+v*cos(a)
            m.ellipsoid((px,py,1.3),(.4,.4,.4),rgb(['efb752','db7897','eee4ce'][j%3]),n=6,k=4)
    # Northwest timber pergola and deck.
    m.box((-26,24,.61),(15,10,.28),wood)
    for x in (-32,-20):
        for y in (20,28):m.box((x,y,2.65),(.4,.4,4),dark)
    for x in range(-33,-18,2):m.box((x,24,4.85),(.32,11,.3),wood)
    for y in (20,28):m.box((-26,y,4.55),(15,.35,.4),dark)
    m.box((-26,27,1.15),(10,.8,.8),wood)
    # Northeast play island: climbing tower, slide and balance posts.
    m.beam((27,23,.48),(27,23,.62),9,rgb('d9aa6d'),n=32)
    for x in (23,26):
        for y in (22,25):m.box((x,y,1.8),(.25,.25,2.5),dark)
    m.box((24.5,23.5,2.9),(4,4,.3),rgb('e9ad45'))
    for y in (21.5,25.5):m.box((24.5,y,3.5),(4,.15,.95),rgb('589caa'))
    strip(m,[(26.5,23.5,2.95),(29,23.5,1.4),(32,23.5,.7)],1.7,rgb('d9654c'))
    for i in range(6):m.box((22.5-i*.35,23.5,2.7-i*.36),(.42,1.5,.18),wood)
    for i in range(7):m.beam((24+i*1.2,17,.6),(24+i*1.2,17,1.0+.15*(i%3)),.3,rgb('e3bc67'))
    m.save('parkFurniture')
    lines=[];batch(lines,'parkFurniture',[([x,y,0],0,[1,1,1]) for x,y in centers])
    # Circular pool surface follows the existing round stone basin.
    for i,(x,y) in enumerate(centers):
        lines.append(f'Lathe {{ id: pool{i}; profile: [[0.02,0,0],[10.1,0,0]]; segments: 64; position: [{x},{y},0.71]; WaterMaterial {{ baseColor: "#6e9e8e"; deepColor: "#244d47"; depthFadeDistance: 0.8; opacity: 0.6; roughness: 0.18; specular: 0.35; waveIntensity: 0.07; flowSpeed: 0.25 }} }}')
    write('ParkDetails',lines)
    names=[]
    # Four gait poses per outfit: physical geometry, not screen sprites.
    for color in range(2):
        for pose in range(4):
            m=Mesh();s=sin(pose*pi/2);skin=rgb('dba784');cloth=rgb(['d27655','498da4'][color]);pants=rgb('354c58')
            m.ellipsoid((0,0,1.23),(.23,.32,.4),cloth,n=8,k=5)
            m.ellipsoid((0,0,1.8),(.2,.19,.24),skin,n=8,k=5)
            m.ellipsoid((-.04,0,1.97),(.19,.2,.11),rgb('544537'),n=8,k=4)
            for side in (-1,1):
                hip=(0,side*.14,.99);foot=(side*s*.35,side*.14,.13)
                m.beam(hip,foot,.10,pants);m.box((foot[0]+.05,foot[1],.08),(.32,.2,.13),rgb('e5e5d7'))
                m.beam((0,side*.31,1.48),(-side*s*.32,side*.34,.94),.085,cloth)
                m.ellipsoid((-side*s*.32,side*.34,.92),(.09,.09,.1),skin,n=6,k=4)
            name=f'walker{color*4+pose}';m.save(name);names.append(name)
    for pose in range(2):
        m=Mesh();m.ellipsoid((0,0,0),(.4,.13,.15),rgb('ebeee7'),n=8,k=4)
        for side in (-1,1):
            m.tri((.15,0,.06),(-.25,side*1.1,.35 if pose==0 else -.35),(-.32,side*.2,0),rgb('d3ddd7'))
            m.tri((-.32,side*.2,0),(-.25,side*1.1,.35 if pose==0 else -.35),(.15,0,.06),rgb('d3ddd7'))
        m.beam((.3,0,0),(.53,0,0),.055,rgb('e8b75b'),n=5)
        name=f'parkBird{pose}';m.save(name);names.append(name)
    # Fountain droplets now use a small shared SSDL mesh in Fountains.ssdl.
    life=[]
    for name in names:
        life.extend([f'Model {{ id: {name}Source; source: "assets/{name}.glb"; visible: false }}',f'Prefab {{ id: {name}Prefab; source: {name}Source }}',f'Instances {{ id: {name}Batch; prefab: {name}Prefab; placement: "explicit"; positions: [] }}'])
    write('ParkLife',life)

    from fountain_assets import build as build_fountains
    build_fountains(env)
