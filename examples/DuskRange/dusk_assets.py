import math, random, struct, json, zlib, pathlib
P=pathlib.Path(__file__).resolve().parent
A=P/'assets'
A.mkdir(exist_ok=True)
random.seed(91)
def png(name,kind):
 n=256; data=bytearray()
 for y in range(n):
  data.append(0)
  for x in range(n):
   grain=random.uniform(-18,18); wave=math.sin(x*.14+math.sin(y*.02)*3)
   if kind=='soil':
    q=grain+10*math.sin(x*.17)*math.cos(y*.11); c=[92+q,86+q,65+q];
    if random.random()<.07:c=[v+35 for v in c]
   elif kind=='wood':
    q=grain*.4+18*wave+8*math.sin(x*.8+math.sin(y*.03)); c=[117+q,91+q,57+q]
   elif kind=='metal':
    q=grain*.25; c=[52+q,94+q,94+q]
    if random.random()<.09 or (x%64<2):c=[120+grain,74+grain,40+grain]
   elif kind=='concrete':
    q=grain*.6+6*math.sin(x*.12)*math.sin(y*.15); c=[139+q,141+q,127+q]
   elif kind=='normal':c=[128+grain*.3,128+random.uniform(-6,6),254]
   else:c=[0,160+grain*3,0]
   data.extend(int(max(0,min(255,v))) for v in c)
 def chunk(t,b):return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b)&0xffffffff)
 (A/(name+'.png')).write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',n,n,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(data)))+chunk(b'IEND',b''))
for k in ['soil','wood','metal','concrete','normal','rough']:png(k,k)
# Authored botanical mesh: tapered branching trunk and irregular evergreen needle fans.
# glTF vertices are Y-up; SSDL model loader handles the model coordinate conversion.
def model(name,rock=False,grass=False):
 groups=[[],[],[],[]]
 def tri(a,b,c,m):groups[m].extend([a,b,c])
 def branch(a,b,r1,r2,m):
  d=[b[i]-a[i] for i in range(3)]; length=math.sqrt(sum(v*v for v in d)); d=[v/length for v in d]
  u=[d[2],0,-d[0]]
  if sum(v*v for v in u)<.01:u=[1,0,0]
  q=math.sqrt(sum(v*v for v in u));u=[v/q for v in u];v=[d[1]*u[2]-d[2]*u[1],d[2]*u[0]-d[0]*u[2],d[0]*u[1]-d[1]*u[0]]
  rings=[]
  for p,r in [(a,r1),(b,r2)]:rings.append([[p[j]+r*(u[j]*math.cos(i*math.tau/7)+v[j]*math.sin(i*math.tau/7)) for j in range(3)] for i in range(7)])
  for i in range(7):j=(i+1)%7;tri(rings[0][i],rings[0][j],rings[1][j],m);tri(rings[0][i],rings[1][j],rings[1][i],m)
 if grass:
  for i in range(40):
   x=random.uniform(-.5,.5);z=random.uniform(-.5,.5);h=random.uniform(.18,.7);w=random.uniform(.025,.055);a=random.random()*math.tau
   side=[math.cos(a)*w,0,math.sin(a)*w];bend=[math.sin(a)*h*.4,0,math.cos(a)*h*.4]
   lo=[x,0,z];mid=[x+bend[0]*.4,h*.55,z+bend[2]*.4];tip=[x+bend[0],h,z+bend[2]]
   l=[lo[j]-side[j] for j in range(3)];r=[lo[j]+side[j] for j in range(3)];ml=[mid[j]-side[j]*.5 for j in range(3)];mr=[mid[j]+side[j]*.5 for j in range(3)]
   tri(l,r,mr,1+i%3);tri(l,mr,ml,1+i%3);tri(ml,mr,tip,1+i%3)
 elif not rock:
  branch([0,0,0],[.13,10,0],.28,.025,0)
  for level in range(11):
   h=2+level*.66; radius=3.3*(1-level/13)
   for k in range(8):
    ang=k*math.tau/8+level*.57+random.random()*.2
    end=[math.cos(ang)*radius,h+.22,math.sin(ang)*radius]
    branch([0,h+.3,0],end,.055,.012,0)
    for t in [.3,.5,.7,.9,1.0]:
     center=[end[0]*t,h+.28+t*.1,end[2]*t]; spread=radius*(1-t)*.55+.24
     tip=[center[0]*1.12,center[1]+.55,center[2]*1.12]
     for s in range(5):
      an=ang+s*math.tau/5
      a=[center[0]+math.cos(an)*spread,center[1]+random.uniform(-.12,.12),center[2]+math.sin(an)*spread]
      b=[center[0]+math.cos(an+.9)*spread,center[1]-.1,center[2]+math.sin(an+.9)*spread]
      tri(a,b,tip,1+random.randrange(3))
 else:
  rings=[]
  for y,r in [(0,1.2),(.6,1.5),(1.45,.85),(1.7,.25)]:
   rings.append([[math.cos(i*math.tau/9)*r*random.uniform(.8,1.2),y+random.uniform(-.1,.1),math.sin(i*math.tau/9)*r] for i in range(9)])
  for k in range(3):
   for i in range(9):j=(i+1)%9;tri(rings[k][i],rings[k+1][i],rings[k+1][j],1);tri(rings[k][i],rings[k+1][j],rings[k][j],1)
 blob=bytearray();views=[];access=[];prims=[]
 def acc(vals,typ):
  while len(blob)%4:blob.append(0)
  off=len(blob);flat=[v for p in vals for v in p];blob.extend(struct.pack('<'+'f'*len(flat),*flat));views.append({'buffer':0,'byteOffset':off,'byteLength':len(flat)*4})
  access.append({'bufferView':len(views)-1,'componentType':5126,'count':len(vals),'type':typ,'min':[min(p[i] for p in vals) for i in range(3)],'max':[max(p[i] for p in vals) for i in range(3)]});return len(access)-1
 for m,verts in enumerate(groups):
  if not verts:continue
  ns=[]
  for i in range(0,len(verts),3):
   a,b,c=verts[i:i+3];u=[b[j]-a[j] for j in range(3)];v=[c[j]-a[j] for j in range(3)];n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];q=math.sqrt(sum(x*x for x in n)) or 1;ns.extend([[x/q for x in n]]*3)
  pa=acc(verts,'VEC3');na=acc(ns,'VEC3')
  off=len(blob);blob.extend(struct.pack('<'+'H'*len(verts),*range(len(verts))))
  views.append({'buffer':0,'byteOffset':off,'byteLength':len(verts)*2,'target':34963})
  access.append({'bufferView':len(views)-1,'componentType':5123,'count':len(verts),'type':'SCALAR','min':[0],'max':[len(verts)-1]})
  prims.append({'attributes':{'POSITION':pa,'NORMAL':na},'indices':len(access)-1,'material':m,'mode':4})
 colors=[[.14,.09,.045,1],[.09,.16,.065,1],[.14,.22,.085,1],[.21,.27,.115,1]] if not rock else [[.3,.3,.3,1]]*4
 gl={'asset':{'version':'2.0','generator':'DuskRange authored botanical mesh'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'mesh':0}],'meshes':[{'primitives':prims}],'materials':[{'doubleSided':True,'pbrMetallicRoughness':{'baseColorFactor':c,'metallicFactor':0,'roughnessFactor':.95}} for c in colors],'buffers':[{'byteLength':len(blob)}],'bufferViews':views,'accessors':access}
 js=json.dumps(gl,separators=(',',':')).encode();js+=b' '*((-len(js))%4);blob+=b'\0'*((-len(blob))%4)
 (A/(name+'.glb')).write_bytes(struct.pack('<III',0x46546c67,2,12+8+len(js)+8+len(blob))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(blob),0x004e4942)+blob)
model('pine');model('rock',True);model('grass',grass=True)
print('Generated 6 textures and 3 authored GLB assets:',A)
