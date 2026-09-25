"""Skyline Garden: reproducible original city, SSDL + GLB assets. No third party assets.
Run python generate.py for massing, python generate.py --detail for the finished city.
"""
import math, random, json, struct, pathlib, sys
from collections import defaultdict
P=pathlib.Path(__file__).parent; A=P/'assets'; A.mkdir(exist_ok=True)
DETAIL='--detail' in sys.argv
R=random.Random(91926); sin,cos,pi=math.sin,math.cos,math.pi
def rgb(h):return tuple(int(h[i:i+2],16)/255 for i in (0,2,4))
def tint(c,k):return tuple(min(1,max(0,x*k)) for x in c)
def sub(a,b):return tuple(x-y for x,y in zip(a,b))
def cross(a,b):return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
def norm(v):
 d=max(1e-12,math.sqrt(sum(x*x for x in v)));return tuple(x/d for x in v)
class Mesh:
 def __init__(self):self.v=[];self.n=[];self.c=[]
 def tri(self,a,b,c,color):
  n=norm(cross(sub(b,a),sub(c,a)))
  if sum(x*x for x in n)<.5:return
  for p in (a,b,c):
   self.v.extend((p[0],p[2],-p[1]));self.n.extend((n[0],n[2],-n[1]));self.c.extend([(x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4) for x in color]+[1])
 def quad(self,a,b,c,d,col):self.tri(a,b,c,col);self.tri(a,c,d,col)
 def box(self,p,s,col,yaw=0):
  vs=[]
  for z in (-1,1):
   for y in (-1,1):
    for x in (-1,1):vs.append((p[0]+x*s[0]/2*cos(yaw)-y*s[1]/2*sin(yaw),p[1]+x*s[0]/2*sin(yaw)+y*s[1]/2*cos(yaw),p[2]+z*s[2]/2))
  for f in [(0,2,3,1),(4,5,7,6),(0,1,5,4),(2,6,7,3),(0,4,6,2),(1,3,7,5)]:self.quad(*[vs[k] for k in f],col)
 def beam(self,a,b,r,col,n=7):
  d=norm(sub(b,a));u=norm(cross(d,(0,0,1) if abs(d[2])<.9 else (0,1,0)));v=cross(d,u)
  rings=[[(p[0]+r*(u[0]*cos(i*2*pi/n)+v[0]*sin(i*2*pi/n)),p[1]+r*(u[1]*cos(i*2*pi/n)+v[1]*sin(i*2*pi/n)),p[2]+r*(u[2]*cos(i*2*pi/n)+v[2]*sin(i*2*pi/n))) for i in range(n)] for p in (a,b)]
  for i in range(n):
   j=(i+1)%n;self.quad(rings[0][i],rings[0][j],rings[1][j],rings[1][i],col);self.tri(a,rings[0][j],rings[0][i],col);self.tri(b,rings[1][i],rings[1][j],col)
 def ellipsoid(self,p,s,col,n=10,k=6):
  rings=[]
  for j in range(1,k):
   a=pi*j/k;r=[]
   for i in range(n):
    t=i*2*pi/n;f=R.uniform(.88,1.12);r.append((p[0]+s[0]*sin(a)*cos(t)*f,p[1]+s[1]*sin(a)*sin(t)*f,p[2]+s[2]*cos(a)*f))
   rings.append(r)
  for i in range(n):
   q=(i+1)%n;self.tri((p[0],p[1],p[2]+s[2]),rings[0][i],rings[0][q],col);self.tri((p[0],p[1],p[2]-s[2]),rings[-1][q],rings[-1][i],col)
   for j in range(len(rings)-1):self.quad(rings[j][i],rings[j+1][i],rings[j+1][q],rings[j][q],tint(col,R.uniform(.80,1.16)))
 def save(self,name,metal=0,rough=.8,glow=()):
  # One primitive per material. `glow` appends self-lit parts; the engine reads emissiveFactor
  # straight through, so a baked lens keeps the HDR punch the UnlitMaterial layer used to give it.
  parts=[(self,{'pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'metallicFactor':metal,'roughnessFactor':rough}})]
  for mesh,emissive in glow:parts.append((mesh,{'pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'metallicFactor':0,'roughnessFactor':1},'emissiveFactor':list(emissive)}))
  vv=[];nn=[];cc=[];spans=[]
  for mesh,_ in parts:spans.append((len(vv)//3,len(mesh.v)//3));vv+=mesh.v;nn+=mesh.n;cc+=mesh.c
  bb=bytearray();views=[];acs=[]
  for vals,n,typ in [(vv,3,'VEC3'),(nn,3,'VEC3'),(cc,4,'VEC4')]:
   raw=struct.pack('<%sf'%len(vals),*vals);views.append({'buffer':0,'byteOffset':len(bb),'byteLength':len(raw)});bb.extend(raw)
   ac={'bufferView':len(views)-1,'componentType':5126,'count':len(vals)//n,'type':typ}
   if len(acs)==0:ac.update(min=[min(vals[k::n]) for k in range(n)],max=[max(vals[k::n]) for k in range(n)])
   acs.append(ac)
  count=len(vv)//3;raw=struct.pack('<%sI'%count,*range(count));views.append({'buffer':0,'byteOffset':len(bb),'byteLength':len(raw),'target':34963});bb.extend(raw)
  prims=[]
  for material,(first,span) in enumerate(spans):
   prims.append({'attributes':{'POSITION':0,'NORMAL':1,'COLOR_0':2},'indices':len(acs),'material':material})
   ac={'bufferView':3,'componentType':5125,'count':span,'type':'SCALAR'}
   if first:ac['byteOffset']=first*4
   acs.append(ac)
  doc={'asset':{'version':'2.0','generator':'Skyline Garden original procedural city'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'mesh':0,'name':name}],'meshes':[{'primitives':prims}],'materials':[m for _,m in parts],'buffers':[{'byteLength':len(bb)}],'bufferViews':views,'accessors':acs}
  jj=json.dumps(doc,separators=(',',':')).encode();jj+=b' '*((-len(jj))%4)
  (A/(name+'.glb')).write_bytes(struct.pack('<3I',0x46546c67,2,28+len(jj)+len(bb))+struct.pack('<2I',len(jj),0x4e4f534a)+jj+struct.pack('<2I',len(bb),0x004e4942)+bb)
def js(v):return json.dumps(v,separators=(',',':'))
def write(name,lines):(P/(name+'.ssdl')).write_text('Group {\n id: root\n'+'\n'.join(lines)+'\n}\n',encoding='utf8')
def model(id,name,p=(0,0,0)):return f'Model {{ id: {id}; source: "assets/{name}.glb"; position: {js(p)} }}'
def batch(lines,name,rows):
 if not rows:return
 lines.append(f'Model {{ id: {name}Source; source: "assets/{name}.glb"; visible: false }}')
 lines.append(f'Prefab {{ id: {name}Prefab; source: {name}Source }}')
 for i in range(0,len(rows),480):
  rr=rows[i:i+480]
  if len(rr)==1:lines.append(f'Model {{ id: {name}Only{i}; source: "assets/{name}.glb"; position: {js(rr[0][0])}; scale: {js(rr[0][2])} }}');continue
  lines.append(f'Instances {{ id: {name}Batch{i}; prefab: {name}Prefab; positions: {js([r[0] for r in rr])}; rotations_z: {js([r[1] for r in rr])}; scales: {js([r[2] for r in rr])} }}')
stone=rgb('c7cec9');glass=rgb('548698');edge=rgb('b9d3d8');road=rgb('3b4950');mark=rgb('d6ddd2');orange=rgb('ebad46')
def tower(name,kind):
 m=Mesh();h=100;w=30;d=30
 base=rgb(['628fa0','476d7f','86a9b2','728c94'][kind%4])
 m.box((0,0,4),(42,42,8),stone)
 if kind==3:
  for lev in range(3):m.box((lev*2,0,8+(lev+.5)*29),(34-lev*6,32-lev*5,29),tint(base,1+lev*.08))
 else:m.box((0,0,54),(w,d,92),base)
 if DETAIL:
  for z in range(12,100,4):
   ww=34-(min(2,(z-8)//29)*6) if kind==3 else 30
   dd=32-(min(2,(z-8)//29)*5) if kind==3 else 30
   xx=min(2,(z-8)//29)*2 if kind==3 else 0
   m.box((xx,0,z),(ww+.3,dd+.3,.55),edge)
   for x in range(-12,13,4):
    if abs(x-xx)<ww/2-1:
     for side in (-1,1):m.box((x,side*(dd/2+.12),z+1.9),(2.9,.12,2.5),tint(base,R.uniform(.65,1.35)))
  if kind!=3:
   for x in (-15,-7.5,0,7.5,15):
    for side in (-1,1):m.box((x,side*15.25,54),(.42,.5,92),stone)
  m.box((0,0,101),(18,20,2),stone);m.box((0,0,104),(8,10,5),rgb('627276'))
 m.save(name,.25,.38)
for k in range(4):tower('tower'+str(k),k)
def landmark(name,rounded=False):
 m=Mesh();h=218 if rounded else 248;n=32 if rounded else 4
 def ring(z):
  t=z/h;ang=0 if rounded else t*.25
  rx=(25 if rounded else 29)*(1-.26*t);ry=(20 if rounded else 25)*(1-.12*t)
  return [(rx*cos(i*2*pi/n+ang),ry*sin(i*2*pi/n+ang),z) for i in range(n)]
 rr=[ring(z) for z in range(12,h+1,4)]
 for j in range(len(rr)-1):
  for i in range(n):m.quad(rr[j][i],rr[j][(i+1)%n],rr[j+1][(i+1)%n],rr[j+1][i],rgb('44829a') if rounded else rgb('567581'))
  if DETAIL:
   for i in range(n):m.beam(rr[j][i],rr[j][(i+1)%n],.25,edge,n=4)
 if DETAIL:
  for i in range(n):
   for j in range(len(rr)-1):m.beam(rr[j][i],rr[j+1][i],.3,edge,n=4)
 m.tri(rr[-1][0],rr[-1][1],rr[-1][2],edge)
 for i in range(1,n-1):m.tri(rr[-1][0],rr[-1][i],rr[-1][i+1],edge)
 m.box((0,0,6),(76,66,12),stone)
 m.beam((0,0,h-1),(0,0,h+14),.8,edge)
 m.save(name,.35,.32)
landmark('spire');landmark('oval',True)
def house(name,k):
 m=Mesh();w=22+(k%2)*6;d=22;h=[12,18,25,10,16,22][k];col=rgb(['e4ddd0','c6d5d7','ddd8c8','ebe6dc','bdcacc','e6ded1'][k])
 m.box((0,0,h/2),(w,d,h),col)
 if DETAIL:
  for z in range(3,h,4):
   for x in range(-int(w/2)+3,int(w/2),5):
    for side in (-1,1):m.box((x,side*(d/2+.1),z),(3,.2,2),rgb('397082'))
   for y in range(-8,9,5):
    for side in (-1,1):m.box((side*(w/2+.1),y,z),(.2,3,2),rgb('4d7481'))
  m.box((0,0,h+.45),(w+1,d+1,.9),orange if k%3==0 else stone)
  m.box((0,0,h+.95),(w-3,d-3,.25),rgb('91a9a9') if k%3==0 else rgb('869596'))
  m.box((3,2,h+1.5),(4,5,1.3),stone)
  m.box((0,-d/2-1.8,3),(w*.7,4,.4),orange)
 m.save(name)
for k in range(6):house('house'+str(k),k)
for k in range(3):
 m=Mesh();m.beam((0,0,0),(0,0,7),.65,rgb('776b4c'))
 for i in range(6):
  t=i*2*pi/6;m.ellipsoid((cos(t)*2.8,sin(t)*2.8,7+(i%3)*.7),(3.6,3.5,4),rgb(['3d713e','527e43','386846'][k]),n=8,k=5)
 m.ellipsoid((0,0,10),(4,4,3.8),rgb(['497b43','668a49','40724d'][k]),n=9,k=5);m.save('tree'+str(k))
# City layout, preserved between massing and detail passes.
R.seed(1919); lots=[];groups=defaultdict(list)
xs=[-510,-350,-190,-30,130,290,450];ys=[-440,-280,-120,40,200,360]
for ix in range(6):
 for iy in range(5):
  cx=(xs[ix]+xs[ix+1])/2;cy=(ys[iy]+ys[iy+1])/2
  cbd=iy>=3 and 1<=ix<=4
  park=(ix,iy) in [(2,2),(3,2),(0,4),(5,1)]
  lots.append({'x':cx,'y':cy,'type':'park' if park else 'cbd' if cbd else 'neighborhood'})
  if park:continue
  if cbd:
   for dx,dy in [(-37,-37),(37,-37),(-37,37),(37,37)]:
    x,y=cx+dx,cy+dy
    if (abs(x-87)<45 and abs(y-157)<45) or (abs(x+147)<45 and abs(y-243)<45):continue
    h=R.uniform(70,165)+(45 if ix in (2,3) else 0);k=R.randrange(4)
    groups['tower'+str(k)].append(([x,y,.5],0,[R.uniform(.85,1.12),R.uniform(.8,1.12),h/100]))
  else:
   for dx in (-45,0,45):
    for dy in (-43,8,53):
     k=R.randrange(6);groups['house'+str(k)].append(([cx+dx+R.uniform(-3,3),cy+dy,.5],0,[R.uniform(.85,1.12),R.uniform(.85,1.04),R.uniform(.85,1.35)]))
downtown=[];hood=[]
for name,rows in groups.items():batch(downtown if name.startswith('tower') else hood,name,rows)
downtown += [model('crown','spire',(87,157,.5)),model('ellipse','oval',(-147,243,.5))]
write('Downtown',downtown);write('Neighborhoods',hood)
# One continuous height field, a lowered river channel and rolling mountain backdrop.
from terrain_form import height,raw_height
heights=[round(raw_height(-2400+i*20,-1100+j*20),2) for j in range(201) for i in range(241)]
terrain_material='PrincipledMaterial { baseColor: "#779168"; roughness: 1 }'
terrain_textures=[]
if DETAIL:
 terrain_textures=['Texture { id: terrainColor; source: "assets/grass-color.png" }','Texture { id: terrainNormal; source: "assets/grass-normal.png" }']
 terrain_material='PrincipledMaterial { baseColor: "#ffffff"; baseColorMap: terrainColor; normalMap: terrainNormal; normalScale: 0.35; uvScale: [0.02,0.02]; roughness: 1 }'
terrain_tiles=[]
for tx in range(2):
 for ty in range(2):
  hh=[round(raw_height(-2400+tx*2400+i*20,-1100+ty*2000+j*20),2) for j in range(101) for i in range(121)]
  terrain_tiles.append(f'HeightField {{ id: terrain{tx}{ty}; width: 2400; depth: 2000; columns: 120; rows: 100; heights: {js(hh)}; position: [{-1200+tx*2400},{-100+ty*2000},0]; {terrain_material} }}')
write('Landscape',terrain_textures+terrain_tiles+['Plane { id: river; width: 4790; depth: 205; position: [0,570,-2]; WaterMaterial { baseColor: "#578b98"; deepColor: "#2e6679"; depthFadeDistance: 10; waveIntensity: 0.15; flowSpeed: 0.4 } }'])
# Transport meshes: road slabs, kerbs, markings and elevated railway.
roads=Mesh();sidewalk=Mesh();rail=Mesh();parks=Mesh();paths=[]
def strip(m,path,width,col):
 pairs=[]
 for i,p in enumerate(path):
  a=path[max(0,i-1)];b=path[min(len(path)-1,i+1)];dx,dy=b[0]-a[0],b[1]-a[1];d=math.hypot(dx,dy);nx=-dy/d*width/2;ny=dx/d*width/2
  pairs.append(((p[0]-nx,p[1]-ny,p[2]),(p[0]+nx,p[1]+ny,p[2])))
 for a,b in zip(pairs,pairs[1:]):m.quad(a[0],b[0],b[1],a[1],col)
def roadway(path,width=22,elevated=False):
 paths.append((path,width));strip(sidewalk,[(x,y,z-.16) for x,y,z in path],width+7,stone);strip(roads,path,width,road)
 if DETAIL:
  for a,b in zip(path,path[1:]):
   dx,dy,dz=[b[i]-a[i] for i in range(3)];d=math.hypot(dx,dy);yaw=math.atan2(dy,dx)
   for t in range(0,int(d)-4,12):
    for off in (-width/4,width/4):
     roads.box((a[0]+dx*t/d-sin(yaw)*off,a[1]+dy*t/d+cos(yaw)*off,a[2]+dz*t/d+.04),(5,.22,.05),mark,yaw)
   strip(roads,[(a[0],a[1],a[2]+.045),(b[0],b[1],b[2]+.045)],.35,orange)
 if elevated:
  for a,b in zip(path,path[1:]):
   for t in (.2,.7):
    x,y,z=[a[i]+(b[i]-a[i])*t for i in range(3)];sidewalk.box((x,y,z/2),(2.2,4,z),stone)
  for sign in (-1,1):
   for a,b in zip(path,path[1:]):
    yaw=math.atan2(b[1]-a[1],b[0]-a[0]);off=sign*(width/2+.6)
    side=[(p[0]-sin(yaw)*off,p[1]+cos(yaw)*off,p[2]+1.3) for p in (a,b)];strip(sidewalk,side,.6,edge)
for x in xs:roadway([(x,-455,.34),(x,390,.34)],26 if x in (-190,130) else 20)
for y in ys:roadway([(-540,y,.37),(478,y,.37)],26 if y==40 else 20)
highway=[(530+75*sin(i*.16),-720+i*55,13+2*sin(i*.13)) for i in range(28)]
roadway(highway,35,True)
roadway([(-860,-560,10),(-600,-550,11),(-350,-575,13),(0,-610,15),(350,-600,16),(560,-530,17),(655,-380,17)],30,True)
roadway([(460,200,.5),(505,250,4),(580,210,9),(650,110,15),(665,-20,15),(620,-115,14),(540,-160,13)],15,True)
roadway([(-720,340,1),(-650,410,2),(-500,430,3),(-200,435,3),(200,438,3),(440,450,5),(555,440,12)],20,True)
for x in range(-590,461,35):sidewalk.box((x,-505,6),(2,6,12),stone)
strip(sidewalk,[(-620,-505,12),(470,-505,12)],13,stone)
for y in (-508,-502):
 strip(rail,[(-620,y,12.4),(470,y,12.4)],4,rgb('787d77'))
 for off in (-.8,.8):strip(rail,[(-620,y+off,12.6),(470,y+off,12.6)],.16,edge)
 if DETAIL:
  for x in range(-620,470,3):rail.box((x,y,12.48),(.35,3,.14),rgb('464d4d'))
for lot in lots:
 x,y=lot['x'],lot['y'];parks.box((x,y,.2),(133,133,.35),rgb('9ba797') if lot['type']!='park' else rgb('70935b'))
 if lot['type']=='park' and not DETAIL:
  strip(parks,[(x-60,y-55,.43),(x+60,y+55,.43)],5,rgb('ccc1a6'));strip(parks,[(x-60,y+55,.44),(x+60,y-55,.44)],5,rgb('ccc1a6'))
roads.save('roads');sidewalk.save('infrastructure');rail.save('rail');parks.save('lots')
write('Transport',[model('streets','roads'),model('bridges','infrastructure'),model('railway','rail'),model('blocks','lots')])
# Trees: avoid buildings and carriageways; the same seed keeps both stages aligned.
trees=defaultdict(list)
def tree(x,y,s=1):
 k=R.randrange(3);trees['tree'+str(k)].append(([round(x,2),round(y,2),round(height(x,y),2)],R.randrange(360),[s,s,s]))
for x in xs:
 for y in range(-420,380,25):
  if min(abs(y-yy) for yy in ys)<23:continue
  for side in (-1,1):tree(x+side*20,y,R.uniform(.7,1.05))
for y in ys:
 for x in range(-485,451,26):
  if min(abs(x-xx) for xx in xs)<23:continue
  for side in (-1,1):tree(x,y+side*18,R.uniform(.7,1.1))
for lot in lots:
 if lot['type']=='park':
  for i in range(28):
   xx,yy,ss=R.uniform(-56,56),R.uniform(-56,56),R.uniform(.8,1.5)
   if DETAIL:
    # Keep entrances open and canopies outside the six metre promenade.
    a=(i+.5)*2*pi/28;xx,yy=59*cos(a),59*sin(a);ss=.75+(ss-.8)*.25
   tree(lot['x']+xx,lot['y']+yy,ss)
for i in range(2700 if DETAIL else 500):
 x=R.uniform(-1800,1800);y=R.uniform(-900,2350)
 if -620<x<720 and -690<y<710:continue
 if 450<y<700:continue
 if y<440 and min(math.hypot(x-p[0],y-p[1]) for path,w in paths for p in path)<40:continue
 tree(x,y,R.uniform(.8,1.7))
if DETAIL:
 for i in range(4300):
  x=R.uniform(-1250,1250);y=R.uniform(-900,1550)
  if -630<x<730 and -680<y<450:continue
  if 445<y<715:continue
  if x>480 and x<720 and y<810:continue
  tree(x,y,R.uniform(.85,1.8))
plant=[]
for name,rows in trees.items():batch(plant,name,rows)
write('Planting',plant)
# Street furniture, cars and train; original meshes shared by instances.
for k,col in enumerate(['e7b548','c4e0e6','d96b54','e5e7df']):
 m=Mesh();m.box((0,0,1),(4.5,1.9,1.1),rgb(col));m.box((-.2,0,1.8),(2.7,1.7,.9),rgb('476d7a'))
 for xx in (-1.4,1.4):
  for yy in (-.97,.97):m.box((xx,yy,.55),(.75,.3,.8),rgb('263038'))
 for side in (-1,1):
  m.box((2.27,side*.62,1.05),(.06,.49,.32),rgb('ccd4cf'))
  m.box((-2.27,side*.62,1.05),(.06,.49,.32),rgb('672a25'))
 m.save('car'+str(k))
 head=Mesh();tail=Mesh()
 for side in (-1,1):
  head.box((2.33,side*.62,1.05),(.08,.43,.25),rgb('fff1d3'));tail.box((-2.33,side*.62,1.05),(.08,.43,.25),rgb('ff3022'))
 # Same boxes, same emission the separate head/tail batches carried; opacity is gone, so dusk is
 # one switch at lightLevel 0.5 rather than an hour-long fade.
 m.save('car'+str(k)+'n',glow=[(head,(12,10,6)),(tail,(7,.04,.015))])
cars=defaultdict(list)
for path,w in paths:
 for a,b in zip(path,path[1:]):
  dx,dy=b[0]-a[0],b[1]-a[1];d=math.hypot(dx,dy);angle=math.atan2(dy,dx)
  for t in range(15,int(d),R.randrange(37,68)):
   off=R.choice([-1,1])*w*.22;cars['car'+str(R.randrange(4))].append(([a[0]+dx*t/d-sin(angle)*off,a[1]+dy*t/d+cos(angle)*off,a[2]+(b[2]-a[2])*t/d+.12],math.degrees(angle)+(180 if off>0 else 0),[1,1,1]))
detail=[]
if DETAIL:
 traffic=[]
 for k in range(4):
  for suffix,asset in (('','car%d'%k),('Night','car%dn'%k)):
   name='car%d%s'%(k,suffix)
   traffic += [f'Model {{ id: {name}Source; source: "assets/{asset}.glb"; visible: false }}',f'Prefab {{ id: {name}Prefab; source: {name}Source }}',f'Instances {{ id: {name}Batch; prefab: {name}Prefab; placement: "explicit"; positions: [] }}']
 write('Traffic',traffic)
 m=Mesh();m.beam((0,0,0),(0,0,9),.14,rgb('546266'));m.beam((0,0,9),(0,3,9),.1,edge);m.box((0,3,8.95),(.6,1.5,.2),stone);m.save('lamp')
 lr=[]
 for y in ys:
  for x in range(-480,450,55):lr.append(([x,y+14,.5],0,[1,1,1]))
 batch(detail,'lamp',lr)
 m=Mesh()
 for i in range(4):
  x=i*19;m.box((x,0,1.7),(18,3.2,3.1),rgb('e8ece7'));m.box((x,0,.75),(18.2,3.3,.9),rgb('e79a38'));m.box((x,0,3.3),(16,2.8,.35),rgb('86999b'))
  for xx in range(-7,9,3):
   for side in (-1,1):m.box((x+xx,side*1.62,2),(2.2,.08,1.2),rgb('335d72'))
 m.save('train')
 detail += ['property bool trafficRunning: true','Model { id: commuter; source: "assets/train.glb"; position: [-560,-508,12.7] }','Vector3dAnimation { target: commuter; property: "position"; from: [-560,-508,12.7]; to: [395,-508,12.7]; duration: 46000; loops: Animation.Infinite; running: true; paused: !trafficRunning }']
write('StreetLife',detail)
if DETAIL:
 from park_assets import build
 build(globals())
 from terrain_assets import build as build_terrain
 build_terrain(globals())
 from night_lighting import build as build_lighting
 build_lighting(globals())
 from window_lighting import build as build_windows
 build_windows(globals())
 from park_gardens import build as build_gardens
 build_gardens(globals())
 from tree_density import build as build_tree_density
 tree_density_info=build_tree_density(P)
 from intersections import build as build_intersections
 build_intersections(globals())
views=[([940,-1270,900],[0,100,65],57),([0,-70,1550],[0,-69,0],60),([440,-440,290],[-60,150,95],58),([-80,-9,48],[-30,40,1],62),([-10,-151,94],[-110,-36,0],62)]
poses=[]
for p,t,f in views:
 dx,dy,dz=[t[i]-p[i] for i in range(3)];poses.append((p,round(math.degrees(math.atan2(dx,dy))%360,4),round(math.degrees(math.atan2(dz,math.hypot(dx,dy))),4),f))
def choose(vals):return ' : '.join(f'main.viewMode === {i} ? {v}' for i,v in enumerate(vals[:-1]))+' : '+str(vals[-1])
pos='['+','.join(choose([v[0][i] for v in poses]) for i in range(3))+']'
scene=['Scene {','id: main','property real viewMode: 0','property bool trafficRunning: true','property real timeOfDay: 14','property string sceneDateTime: "2026-09-19T14:00:00+08:00"','SkyAtmosphere { id: atmosphere }','Environment { id: environment; dateTime: main.sceneDateTime; timeScale: 0 }','SkyLight { id: ambient; intensity: 1 }','DirectionalLight { id: sunlight; atmosphereSunLight: true; castShadows: true }','ExponentialHeightFog { id: haze; fogDensity: 0.001; startDistance: 1200; fogHeightFalloff: 0.25 }',f'CameraView {{ id: cityView; position: {pos}; heading: {choose([v[1] for v in poses])}; pitch: {choose([v[2] for v in poses])}; fov: {choose([v[3] for v in poses])}; duration: 900 }}','Camera { id: camera; initialView: cityView }']
scene += [f'{n} {{ id: {n.lower()} }}' for n in ['Landscape','Transport','Downtown','Neighborhoods','Planting']]+['StreetLife { id: streetlife; trafficRunning: main.trafficRunning }' if DETAIL else 'StreetLife { id: streetlife }','}']
scene=[s.replace('fogDensity: 0.001','fogDensity: 0.00015') for s in scene]
scene.insert(2,'PostProcessVolume { id: optics; unbound: true; priority: 10; blendWeight: 1; settings.lensFlareThreshold: 128 }')
if DETAIL:
 scene[2:2]=['property bool streetLightsEnabled: true','property bool vehicleLightsEnabled: true','property real lampLevel: 0']
 scene[-1:-1]=['Timer { id: lightingClock; interval: 200; repeat: true; running: true; onTriggered: { main.lampLevel = main.streetLightsEnabled ? (main.timeOfDay < 5.5 ? 1 : main.timeOfDay < 6.5 ? 6.5 - main.timeOfDay : main.timeOfDay < 17.75 ? 0 : main.timeOfDay < 18.75 ? main.timeOfDay - 17.75 : 1) : 0; } }','NightLighting { id: nightlighting; level: main.lampLevel }','NightBulbs { id: nightbulbs; level: main.lampLevel }']
 scene[-1:-1]=['WindowGlow { id: windowglow; level: main.lampLevel }','TerrainDetails { id: terraindetails }','GroundCover { id: groundcover }']
 scene[2:2]=['property bool parkRunning: true','property real parkSeconds: 0','property real parkVisitors: 0','property length walkerX: 0','property length fountainZ: 0']
 scene[2:2]=['property real signalPhase: 0','property real stoppedCars: 0','property real trafficSeconds: 0','property real movingCars: 0','property length leadCarX: 0','property length leadCarY: 0']
 scene[-1:-1]=['Intersections { id: intersections; phase: main.signalPhase }']
 scene[-1:-1]=['TreeDensity { id: treedensity }','ParkDetails { id: parkdetails }','ParkGardens { id: parkgardens }','ParkLife { id: parklife }','Fountains { id: fountains; running: main.parkRunning }','Timer { id: parkTick; interval: 100; repeat: true; running: true; onTriggered: { Park.tick(running: main.parkRunning); } }','Traffic { id: traffic }','Timer { id: trafficTick; interval: 100; repeat: true; running: true; onTriggered: { Traffic.tick(running: main.trafficRunning, lightLevel: main.vehicleLightsEnabled ? main.lampLevel : 0, lensLevel: main.lampLevel); } }']
(P/'scene.ssdl').write_text('\n'.join(scene),encoding='utf8')
stats={'stage':'detail' if DETAIL else 'massing','seed':1919,'design_extent_m':[1600,1400],'building_count':sum(map(len,groups.values()))+2,'tree_count':tree_density_info['total'] if DETAIL else sum(map(len,trees.values())),'cars':sum(map(len,cars.values())),'lots':lots,'views':poses,'conceptual':True}
(P/'layout.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding='utf8')
svg=['<svg xmlns="http://www.w3.org/2000/svg" viewBox="-800 -850 1700 1700"><rect x="-800" y="-850" width="1700" height="1700" fill="#cbd4bd"/><g transform="scale(1,-1)">','<rect x="-800" y="470" width="1700" height="200" fill="#75a6b6"/>']
for lot in lots:svg.append(f'<rect x="{lot["x"]-65}" y="{lot["y"]-65}" width="130" height="130" rx="5" fill="'+({'park':'#709765','cbd':'#7899ad','neighborhood':'#e9cf9c'}[lot['type']])+'"/>')
for path,w in paths:svg.append('<polyline points="'+' '.join(f'{x},{y}' for x,y,z in path)+f'" stroke="#58676c" stroke-width="{w}" fill="none"/>')
for name,rows in groups.items():
 for p,a,s in rows:svg.append(f'<rect x="{p[0]-13}" y="{p[1]-13}" width="26" height="26" fill="'+('#355c74' if name.startswith('tower') else '#fff3db')+'"/>')
svg += ['</g><text x="-730" y="-750" font-family="sans-serif" font-size="42" fill="#243f49">SKYLINE GARDEN / MASTERPLAN</text><text x="-730" y="760" font-family="sans-serif" font-size="25" fill="#243f49">N ↑ · CBD / NEIGHBORHOODS / PARKS / RIVER · CONCEPT DESIGN</text></svg>']
(P/'layout.svg').write_text('\n'.join(svg),encoding='utf8')
print(json.dumps({k:v for k,v in stats.items() if k not in ('lots','views')},ensure_ascii=False))
