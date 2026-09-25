"""Native sprite fountains; only surface ripple instances use host updates."""
import json, math

def build(env):
    centers=[(p['x'],p['y']) for p in env['lots'] if p['type']=='park']
    out=['property bool running: true']
    def data(x): return json.dumps(x,separators=(',',':'))
    def emitter(name, position, direction, rate, cap, life, speed, size, spread, seed):
        out.append(f'ParticleEmitter {{ id: {name}; position: {data(position)}; direction: {data(direction)}; shape: "point"; rate: {rate}; maxParticles: {cap}; lifetime: {data(life)}; speed: {data(speed)}; size: {data(size)}; sizeVariation: 0.25; spread: {spread}; gravity: 9.8; drag: 0; colorStart: "#d8f0ee"; colorEnd: "#a1c9c7"; alphaStart: 0.8; alphaEnd: 0; blend: "alpha"; warmup: 2.1; seed: {seed}; maxDrawDistance: 650; emitting: running; playbackSpeed: running ? 1 : 0 }}')
    for pi,(cx,cy) in enumerate(centers):
        # 9.8 m/s reaches 4.9 m above the central nozzle; dies at the water surface.
        emitter(f'crown{pi}',[cx,cy,1.23],[0,0,1],110,240,[2.01,2.03],[9.8,9.8],[.20,.34],4,1900+pi)
        for i in range(8):
            a=i*math.tau/8; c=math.cos(a); s=math.sin(a)
            # vx=2.8, vz=8.5: 1.79 s flight, landing radius about 6.3 m.
            v=math.hypot(2.8,8.5)
            emitter(f'jet{pi}_{i}',[cx+1.3*c,cy+1.3*s,1.23],[2.8*c/v,2.8*s/v,8.5/v],65,125,[1.76,1.79],[v,v],[.14,.23],.65,2000+pi*20+i)
            # Short impact spray is analytic: no collision or per-drop JS writes.
            emitter(f'spray{pi}_{i}',[cx+6.3*c,cy+6.3*s,.77],[0,0,1],24,16,[.36,.40],[2,2.2],[.11,.20],30,3000+pi*20+i)
    # Thin annulus, two triangles per segment; no expensive water shading here.
    verts=[];faces=[]
    for i in range(25):
        a=i*math.tau/24
        for r in (.86,1):verts.extend([round(r*math.cos(a),6),round(r*math.sin(a),6),0])
    for i in range(24):
        k=i*2;faces.extend([k,k+1,k+3,k,k+3,k+2])
    out.extend([f'Mesh {{ id: rippleSource; vertices: {data(verts)}; faces: {data(faces)}; visible: false; PrincipledMaterial {{ baseColor: "#badedc"; opacity: 0.45; roughness: 0.25 }} }}','Prefab { id: ripplePrefab; source: rippleSource }','Instances { id: rippleBatch; prefab: ripplePrefab; placement: "explicit"; positions: [] }'])
    env['write']('Fountains',out)
