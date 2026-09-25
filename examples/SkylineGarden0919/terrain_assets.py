"""Procedural grass textures, ground cover and geological detail."""
import math,random,struct,zlib,json
from collections import defaultdict
from terrain_form import height,park_clear

def png(path,w,h,data):
    def chunk(tag,b):return struct.pack('>I',len(b))+tag+b+struct.pack('>I',zlib.crc32(tag+b)&0xffffffff)
    raw=b''.join(b'\0'+bytes(data[y*w*3:(y+1)*w*3]) for y in range(h))
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw,8))+chunk(b'IEND',b''))

def build(env):
    Mesh,rgb,write,batch,strip,A,P=[env[k] for k in ('Mesh','rgb','write','batch','strip','A','P')]
    rng=random.Random(9244);sin=math.sin;cos=math.cos;pi=math.pi
    # Tileable, multiscale color noise with individual fine blade marks.
    n=512;data=bytearray();normal=bytearray()
    for y in range(n):
        for x in range(n):
            a=x*2*pi/n;b=y*2*pi/n
            f=7*sin(a*3+cos(b*2))+5*cos(b*5+sin(a*2))+3*sin(a*17+b*11)+rng.uniform(-7,7)
            data.extend(int(max(0,min(255,c+f))) for c in (93,125,61))
            normal.extend((int(128+rng.uniform(-17,17)),int(128+rng.uniform(-17,17)),252))
    for i in range(18000):
        x=rng.randrange(n);y=rng.randrange(n);length=rng.randrange(2,7);col=rng.choice([(115,141,73),(79,112,52),(130,142,83),(86,122,57)])
        for j in range(length):
            xx=(x+j//3)%n;yy=(y+j)%n;off=(yy*n+xx)*3;data[off:off+3]=bytes(col)
    png(A/'grass-color.png',n,n,data);png(A/'grass-normal.png',n,n,normal)
    # Each tuft is a small low-poly fan of bent blades, with real thickness in silhouette.
    for kind in range(4):
        m=Mesh()
        for j in range(18):
            a=rng.random()*2*pi;r=rng.random()*.65;px,py=r*cos(a),r*sin(a)
            yaw=rng.random()*2*pi;w=rng.uniform(.035,.075);h=rng.uniform(.18,.52)
            dx,dy=cos(yaw)*w,sin(yaw)*w;lean=rng.uniform(.05,.2)
            p0=(px-dx,py-dy,0);p1=(px+dx,py+dy,0);p2=(px+dx+lean,py+dy,h*.65);p3=(px+lean*1.4,py,h)
            col=rgb(['688b3f','7a984e','587d39','8a9f53'][kind])
            m.tri(p0,p1,p2,col);m.tri(p0,p2,p3,col);m.tri(p2,p1,p0,col);m.tri(p3,p2,p0,col)
        m.save('grassTuft'+str(kind))
    for k in range(2):
        m=Mesh()
        m.ellipsoid((0,0,.48),(1.5,1.1,.95),rgb(['8e9587','a1a494'][k]),n=7,k=4)
        m.ellipsoid((1.1,.3,.25),(.8,.65,.6),rgb('949b8a'),n=6,k=4)
        m.save('fieldRock'+str(k))
    m=Mesh()
    for j in range(5):
        a=j*2*pi/5;m.ellipsoid((.55*cos(a),.55*sin(a),.55),(.65,.65,.65),rgb('567a3e'),n=7,k=4)
    m.save('meadowShrub')
    centers=[(p['x'],p['y']) for p in env['lots'] if p['type']=='park']
    rows=defaultdict(list);placements=[]
    for cx,cy in centers:
        count=0
        while count<1550:
            x,y=rng.uniform(-63,63),rng.uniform(-63,63)
            if not park_clear(x,y):continue
            k=count%4;s=rng.uniform(.65,1.1)
            rows['grassTuft'+str(k)].append(([cx+x,cy+y,.397],rng.randrange(360),[s,s,s*.7]));placements.append([cx,cy,x,y]);count+=1
        # Shrubs collect near the outer tree belt, leaving entrance axes open.
        for j in range(20):
            a=(j+.5)*2*pi/20;x,y=55*cos(a),55*sin(a)
            if not park_clear(x,y,1.5):continue
            rows['meadowShrub'].append(([cx+x,cy+y,.4],rng.randrange(360),[1,1,rng.uniform(.6,.9)]))
    def road_distance(x,y):
        best=1e10
        for path,w in env['paths']:
            for a,b in zip(path,path[1:]):
                dx,dy=b[0]-a[0],b[1]-a[1];t=max(0,min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)))
                best=min(best,math.hypot(x-a[0]-t*dx,y-a[1]-t*dy)-w/2)
        return best
    # Outside-city meadows: close forest edges and the north river bank.
    for i in range(1200):
        x=rng.uniform(-1300,1300);y=rng.choice([rng.uniform(730,1100),rng.uniform(-880,-690)])
        if road_distance(x,y)<13:continue
        s=rng.uniform(1.2,2.6);rows['grassTuft'+str(i%4)].append(([x,y,height(x,y)+.03],rng.randrange(360),[s,s,s]))
    for i in range(400):
        x=rng.uniform(-1750,1750);y=rng.uniform(735,1800)
        s=rng.uniform(1.2,4.8);rows['fieldRock'+str(i%2)].append(([x,y,height(x,y)-.2],rng.randrange(360),[s,s*.8,s*.65]))
        if i%2==0:rows['meadowShrub'].append(([x+4,y+3,height(x+4,y+3)],rng.randrange(360),[2,2,1.5]))
    for i in range(160):
        x=-2000+i*25;y=465+4*sin(i*.63);s=rng.uniform(.6,1.8)
        rows['fieldRock'+str(i%2)].append(([x,y,height(x,y)-.25],rng.randrange(360),[s*2,s,s*.6]))
    lines=[]
    for name,r in rows.items():
        assert len(r)<=2048,(name,len(r))
        batch(lines,name,r)
    write('GroundCover',lines)
    ground=['Texture { id: grassColor; source: "assets/grass-color.png" }','Texture { id: grassNormal; source: "assets/grass-normal.png" }']
    for i,(cx,cy) in enumerate(centers):
        ground.append(f'Plane {{ id: lawn{i}; width: 132; depth: 132; position: [{cx},{cy},0.39]; PrincipledMaterial {{ baseColor: "#ffffff"; baseColorMap: grassColor; normalMap: grassNormal; normalScale: 0.4; uvScale: [0.075,0.075]; roughness: 1 }} }}')
    # Shore sand follows sampled topography, no floating strips or slabs.
    m=Mesh()
    for y in (460,680):
        for x in range(-2380,2380,20):
            m.quad(*[(xx,yy,height(xx,yy)+.055) for xx,yy in [(x,y-4.5),(x+20,y-4.5),(x+20,y+4.5),(x,y+4.5)]],rgb('a99d77'))
    m.save('riverbank');ground.append('Model { id: riverShore; source: "assets/riverbank.glb" }')
    write('TerrainDetails',ground)
    stats={'grass_tufts':sum(len(r) for n,r in rows.items() if n.startswith('grassTuft')),'rocks':sum(len(r) for n,r in rows.items() if n.startswith('fieldRock')),'shrubs':len(rows['meadowShrub']),'height_grid':[241,201],'park_grass_clear':all(park_clear(x,y) for cx,cy,x,y in placements)}
    (P/'terrain-layout.json').write_text(json.dumps(stats,indent=2));print(json.dumps(stats))
