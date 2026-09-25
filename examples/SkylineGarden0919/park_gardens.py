"""Layered planting islands inside the four lawn quadrants of each park."""
import math, random, json
from collections import defaultdict
from terrain_form import park_clear

def build(env):
    Mesh,rgb,write,batch=[env[k] for k in ('Mesh','rgb','write','batch')]
    rng=random.Random(191904); saved=env['R'].getstate();env['R'].seed(191904)
    m=Mesh()
    for x,y,z,r in [(-.5,0,.52,.65),(.45,.15,.67,.75),(0,-.4,.45,.55),(0,.38,.65,.6)]:
        m.ellipsoid((x,y,z),(r,r,r*.8),rgb('4f7747'),n=7,k=4)
    m.save('gardenShrub')
    for name,color in [('gardenLavender','9e8db4'),('gardenRose','ca8893'),('gardenCream','ddd4ad')]:
        m=Mesh()
        for i in range(7):
            a=i*math.tau/7;r=.25 if i else 0;x=r*math.cos(a);y=r*math.sin(a);h=.6+.2*(i%3)
            m.beam((x,y,0),(x,y,h),.035,rgb('65844b'),n=4)
            m.ellipsoid((x,y,h),(.16,.16,.25),rgb(color),n=5,k=3)
            m.ellipsoid((x,y,.23),(.29,.24,.18),rgb('64824d'),n=5,k=3)
        m.save(name)
    m=Mesh()
    for i in range(12):
        a=i*math.tau/12;h=.65+.17*(i%4);r=.35+.1*(i%3)
        p=(r*math.cos(a),r*math.sin(a),h)
        m.tri((-.07,0,0),p,(.07,0,0),rgb('999964'))
        m.tri((0,.07,0),p,(0,-.07,0),rgb('859150'))
    m.save('gardenSedge')
    env['R'].setstate(saved)
    centers=[(p['x'],p['y']) for p in env['lots'] if p['type']=='park']
    islands=[(sx*11,sy*30,4.8,7.0) for sx in (-1,1) for sy in (-1,1)] + [(sx*29,sy*9,6,3.2) for sx in (-1,1) for sy in (-1,1)]
    rows=defaultdict(list);records=[]
    for pi,(cx,cy) in enumerate(centers):
        for j,(ix,iy,rx,ry) in enumerate(islands):
            # Small canopy sits over the island, safely inside the circular walk.
            tx,ty=(ix,math.copysign(26,iy)) if abs(ix)==11 else (math.copysign(26,ix),iy)
            if park_clear(tx,ty,3.5):
                scale=.46+.025*((j+pi)%3)
                rows['tree'+str((j+pi)%3)].append(([cx+tx,cy+ty,.38],rng.randrange(360),[scale]*3))
                records.append({'kind':'tree','park':pi,'local':[tx,ty]})
            # Poisson-like minimum spacing keeps the foliage from becoming one solid blob.
            chosen=[]
            for attempt in range(500):
                x=ix+rng.uniform(-rx,rx);y=iy+rng.uniform(-ry,ry)
                if ((x-ix)/rx)**2+((y-iy)/ry)**2>1 or not park_clear(x,y,1.0):continue
                if any(math.hypot(x-u,y-v)<1.35 for u,v in chosen):continue
                chosen.append((x,y))
                typ='gardenShrub' if len(chosen)%3==0 else ['gardenLavender','gardenRose','gardenCream'][j%3] if len(chosen)%3==1 else 'gardenSedge'
                scale=rng.uniform(.85,1.25)
                rows[typ].append(([round(cx+x,3),round(cy+y,3),.38],rng.randrange(360),[scale]*3))
                records.append({'kind':typ,'park':pi,'local':[round(x,3),round(y,3)]})
                if len(chosen)>=42:break
    lines=[]
    for name,items in rows.items():batch(lines,name,items)
    write('ParkGardens',lines)
    (env['P']/'park-gardens-layout.json').write_text(json.dumps({'counts':{k:len(v) for k,v in rows.items()},'placements':records},indent=2),encoding='utf8')
    print('Park gardens:',{k:len(v) for k,v in rows.items()})
