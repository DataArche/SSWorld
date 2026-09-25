"""Small deterministic GLB exporter: UVs, normals, textured PBR, curved curb walls."""
import json,math,struct,zlib
from pathlib import Path
import numpy as np
from shapely import constrained_delaunay_triangles
from shapely.geometry.polygon import orient
from .geometry import polygons

def rgb(h):
    return tuple((v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4) for v in [int(h[i:i+2],16)/255 for i in (0,2,4)])

class Mesh:
    def __init__(self):self.v=[];self.n=[];self.uv=[];self.c=[];self.triangles=0
    def tri(self,a,b,c,color,uvscale=1):
        u=[b[i]-a[i] for i in range(3)];v=[c[i]-a[i] for i in range(3)]
        nn=(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]);d=math.sqrt(sum(x*x for x in nn))
        if d<1e-9:return
        self.triangles+=1
        for p in (a,b,c):
            self.v.extend((p[0],p[2],-p[1]));self.n.extend((nn[0]/d,nn[2]/d,-nn[1]/d));self.uv.extend((p[0]/uvscale,p[1]/uvscale));self.c.extend((*color,1))
    def surface(self,g,z,color,uvscale=1):
        for p in polygons(g):
            for t in constrained_delaunay_triangles(p).geoms:
                xy=list(orient(t,sign=1).exterior.coords)[:3]
                pts=[(x,y,z(x,y) if callable(z) else z) for x,y in xy]
                self.tri(*pts,color,uvscale)
    def walls(self,g,z0,z1,color):
        for p in polygons(g):
            p=orient(p,sign=1)
            for ring in [p.exterior,*p.interiors]:
                for a,b in zip(ring.coords,list(ring.coords)[1:]):
                    lo0=z0(*a) if callable(z0) else z0;lo1=z0(*b) if callable(z0) else z0
                    hi0=z1(*a) if callable(z1) else z1;hi1=z1(*b) if callable(z1) else z1
                    self.tri((*a,lo0),(*b,lo1),(*b,hi1),color);self.tri((*a,lo0),(*b,hi1),(*a,hi0),color)
    def box(self,x,y,z,w,d,h,color):
        from shapely.geometry import box
        g=box(x-w/2,y-d/2,x+w/2,y+d/2);self.surface(g,z+h/2,color);self.walls(g,z-h/2,z+h/2,color)
    def cylinder(self,x,y,z,r,h,color,segments=12):
        from shapely.geometry import Point
        p=Point(x,y).buffer(r,quad_segs=max(2,segments//4));self.surface(p,z+h,color);self.walls(p,z,z+h,color)
    def save(self,path,texture=None,roughness=.9):
        if not self.v:return None
        binary=bytearray();views=[];acc=[]
        # Share only identical serialized attributes: preserve hard normals, UVs and colors.
        attributes=np.concatenate([np.asarray(vals,dtype='<f4').reshape(-1,n) for vals,n in [(self.v,3),(self.n,3),(self.uv,2),(self.c,4)]],axis=1)
        unique,index=np.unique(attributes,axis=0,return_inverse=True)
        for vals,n,typ in [(unique[:,:3],3,'VEC3'),(unique[:,3:6],3,'VEC3'),(unique[:,6:8],2,'VEC2'),(unique[:,8:],4,'VEC4')]:
            vals=vals.reshape(-1)
            raw=vals.astype('<f4').tobytes();views.append({'buffer':0,'byteOffset':len(binary),'byteLength':len(raw)});binary.extend(raw)
            item={'bufferView':len(views)-1,'componentType':5126,'count':len(vals)//n,'type':typ}
            if not acc:item.update(min=[float(min(vals[k::n])) for k in range(n)],max=[float(max(vals[k::n])) for k in range(n)])
            acc.append(item)
        indices=index.astype('<u4').tobytes()
        views.append({'buffer':0,'byteOffset':len(binary),'byteLength':len(indices),'target':34963});binary.extend(indices)
        acc.append({'bufferView':4,'componentType':5125,'count':len(self.v)//3,'type':'SCALAR'})
        mat={'doubleSided':False,'pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'metallicFactor':0,'roughnessFactor':roughness}}
        doc={'asset':{'version':'2.0','generator':'SSWorld Road Template 1'},'scene':0,'scenes':[{'nodes':[0]}],
          'nodes':[{'mesh':0,'name':Path(path).stem}], 'meshes':[{'primitives':[{'attributes':{'POSITION':0,'NORMAL':1,'TEXCOORD_0':2,'COLOR_0':3},'indices':4,'material':0}]}],
          'materials':[mat],'accessors':acc,'bufferViews':views}
        if texture:
            png=Path(texture).read_bytes();views.append({'buffer':0,'byteOffset':len(binary),'byteLength':len(png)});binary.extend(png);binary.extend(b'\0'*((-len(binary))%4))
            doc['images']=[{'bufferView':len(views)-1,'mimeType':'image/png'}]
            doc['samplers']=[{'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':10497}]
            doc['textures']=[{'source':0,'sampler':0}];mat['pbrMetallicRoughness']['baseColorTexture']={'index':0}
        doc['buffers']=[{'byteLength':len(binary)}]
        raw=json.dumps(doc,separators=(',',':')).encode();raw+=b' '*((-len(raw))%4)
        Path(path).write_bytes(struct.pack('<3I',0x46546c67,2,28+len(raw)+len(binary))+struct.pack('<2I',len(raw),0x4e4f534a)+raw+struct.pack('<2I',len(binary),0x004e4942)+binary)
        if Path(path).stat().st_size>32*1024*1024:raise ValueError('GLB exceeds SSWorld 32 MiB asset limit; reduce tile size')
        return {'triangles':self.triangles,'bytes':Path(path).stat().st_size}

def png(path,arr):
    h,w,_=arr.shape
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    raw=b''.join(b'\0'+row.tobytes() for row in arr.astype('uint8'))
    Path(path).write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))

def _periodic(rng,n,scale):
    """Tileable smooth noise: white noise low-passed in the frequency domain, unit variance."""
    k=np.fft.fftfreq(n)[:,None]**2+np.fft.fftfreq(n)[None,:]**2
    field=np.real(np.fft.ifft2(np.fft.fft2(rng.normal(0,1,(n,n)))*np.exp(-k*(n/scale)**2)))
    return (field-field.mean())/field.std()

def textures(directory,seed):
    rng=np.random.default_rng(seed);n=512;y,x=np.mgrid[:n,:n]
    noise=rng.normal(0,3,(n,n))
    asphalt=np.clip(62+noise+3*_periodic(rng,n,40),0,255)
    asphalt=np.stack([asphalt*.98,asphalt,asphalt*1.02],axis=-1)
    png(directory/'asphalt.png',asphalt)
    grout=((x%128)<2)|((y%64)<2)
    tone=152+noise*.6+2.5*_periodic(rng,n,60); tone[grout]=126
    png(directory/'paving.png',np.stack([tone*1.03,tone*1.015,tone*.97],axis=-1))
    # Lawn tiled every ~24 m: broad mottling, sun-bleached patches and blade-scale noise.
    broad=_periodic(rng,n,6);mid=_periodic(rng,n,24);dry=np.clip(_periodic(rng,n,9)-.6,0,None);fine=rng.normal(0,1,(n,n))
    r=46+5*broad+3*mid+9*dry+4*fine;g=74+8*broad+4*mid+5*dry+6*fine;b=22+3*broad+1*mid+1*dry+2*fine
    png(directory/'grass.png',np.stack([r,g,b],axis=-1).clip(0,255))
