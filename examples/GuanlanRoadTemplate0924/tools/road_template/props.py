"""Procedural low-poly props for the autumn-suburb look: trees, shrubs, houses, workshops.

Local metres, z up, base at z=0. Buildings face -Y (door side) and are centred on their footprint,
so a placement only needs the frontage direction. Every prop is illustrative, never observed data.
"""
import math,random
from .mesh import Mesh,rgb

def _unit(v):
    d=math.sqrt(sum(x*x for x in v)) or 1
    return tuple(x/d for x in v)

def _shade(color,f):return tuple(c*f for c in color)

class PropMesh(Mesh):
    def tri_n(self,a,b,c,na,nb,nc,ca,cb,cc):
        """Triangle with explicit (smooth) normals; winding follows the normals so culling stays correct."""
        u=[b[i]-a[i] for i in range(3)];v=[c[i]-a[i] for i in range(3)]
        f=(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])
        if math.sqrt(sum(x*x for x in f))<1e-9:return
        if sum(f[i]*(na[i]+nb[i]+nc[i]) for i in range(3))<0:b,c,nb,nc,cb,cc=c,b,nc,nb,cc,cb
        self.triangles+=1
        for p,n,col in ((a,na,ca),(b,nb,cb),(c,nc,cc)):
            self.v.extend((p[0],p[2],-p[1]));self.n.extend((n[0],n[2],-n[1]));self.uv.extend((0,0));self.c.extend((*col,1))
    def face(self,pts,color,outward=None):
        """Planar convex polygon; flipped to face `outward` when given."""
        if outward:
            u=[pts[1][i]-pts[0][i] for i in range(3)];v=[pts[2][i]-pts[0][i] for i in range(3)]
            f=(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])
            if sum(f[i]*outward[i] for i in range(3))<0:pts=pts[::-1]
        for i in range(1,len(pts)-1):self.tri(pts[0],pts[i],pts[i+1],color)
    def cuboid(self,x0,y0,z0,x1,y1,z1,color,top=None,bottom=False):
        c=[(x0,y0),(x1,y0),(x1,y1),(x0,y1)]
        self.face([(x,y,z1) for x,y in c],top or color,(0,0,1))
        if bottom:self.face([(x,y,z0) for x,y in c],color,(0,0,-1))
        for (ax,ay),(bx,by) in zip(c,c[1:]+c[:1]):
            n=(by-ay,ax-bx,0)
            self.face([(ax,ay,z0),(bx,by,z0),(bx,by,z1),(ax,ay,z1)],color,n)
    def prism(self,x,y,z0,z1,r0,r1,sides,color,top=True):
        """Tapered upright prism (trunks, posts) with smooth side normals."""
        ring=[(math.cos(2*math.pi*i/sides),math.sin(2*math.pi*i/sides)) for i in range(sides)]
        slope=(r0-r1)/max(z1-z0,1e-6)
        for (ca,sa),(cb,sb) in zip(ring,ring[1:]+ring[:1]):
            na=_unit((ca,sa,slope));nb=_unit((cb,sb,slope))
            a0=(x+ca*r0,y+sa*r0,z0);b0=(x+cb*r0,y+sb*r0,z0);a1=(x+ca*r1,y+sa*r1,z1);b1=(x+cb*r1,y+sb*r1,z1)
            self.tri_n(a0,b0,b1,na,nb,nb,color,color,color);self.tri_n(a0,b1,a1,na,nb,na,color,color,color)
        if top and r1>0:self.face([(x+c*r1,y+s*r1,z1) for c,s in ring],color,(0,0,1))

# ---------------------------------------------------------------- vegetation

def _icosphere(subdivisions=1):
    t=(1+5**.5)/2
    verts=[_unit(v) for v in [(-1,t,0),(1,t,0),(-1,-t,0),(1,-t,0),(0,-1,t),(0,1,t),(0,-1,-t),(0,1,-t),(t,0,-1),(t,0,1),(-t,0,-1),(-t,0,1)]]
    faces=[(0,11,5),(0,5,1),(0,1,7),(0,7,10),(0,10,11),(1,5,9),(5,11,4),(11,10,2),(10,7,6),(7,1,8),
           (3,9,4),(3,4,2),(3,2,6),(3,6,8),(3,8,9),(4,9,5),(2,4,11),(6,2,10),(8,6,7),(9,8,1)]
    for _ in range(subdivisions):
        cache={};out=[]
        def mid(i,j):
            k=(min(i,j),max(i,j))
            if k not in cache:cache[k]=len(verts);verts.append(_unit([(verts[i][n]+verts[j][n])/2 for n in range(3)]))
            return cache[k]
        for a,b,c in faces:
            ab,bc,ca=mid(a,b),mid(b,c),mid(c,a);out+=[(a,ab,ca),(b,bc,ab),(c,ca,bc),(ab,bc,ca)]
        faces=out
    return verts,faces

def _lump(mesh,rng,center,radius,palette,squash=1.0,z_range=None,subdivisions=1,volume=None):
    """One foliage clump: jittered sphere, colour drawn per vertex, darker underneath and inside.

    `volume` (centre, radii) makes the normals follow the whole canopy instead of the clump, so a
    crown of many clumps is lit as one mass (lit side / shadow side) while keeping a broken outline.
    """
    verts,faces=_icosphere(subdivisions)
    cx,cy,cz=center;lo,hi=z_range or (cz-radius,cz+radius)
    pts=[];nrm=[];col=[]
    for v in verts:
        k=rng.uniform(.8,1.18);p=(cx+v[0]*radius*k,cy+v[1]*radius*k,cz+v[2]*radius*k*squash)
        light=.36+.64*min(1,max(0,(p[2]-lo)/max(hi-lo,1e-6)))
        n=v
        if volume:
            (vx,vy,vz),(rx,ry,rz)=volume;w=((p[0]-vx)/rx,(p[1]-vy)/ry,(p[2]-vz)/rz);depth=min(1,math.sqrt(sum(a*a for a in w)))
            n=tuple(.7*a+.3*b for a,b in zip(_unit(w),v));light*=.55+.45*depth
        jitter=[rng.uniform(-.3,.3) for _ in range(3)]
        base=palette[rng.randrange(len(palette))];f=light*rng.uniform(.8,1.1)
        # Shadowed foliage shifts toward brown, not olive: green and blue fall off faster than red.
        tint=(base[0]*f,base[1]*f*(.72+.28*f),base[2]*f*(.5+.5*f))
        pts.append(p);nrm.append(_unit((n[0]+jitter[0],n[1]+jitter[1],n[2]+.2+jitter[2])));col.append(tint)
    for a,b,c in faces:mesh.tri_n(pts[a],pts[b],pts[c],nrm[a],nrm[b],nrm[c],col[a],col[b],col[c])

TRUNK=rgb('4e3b2b')
PALETTES={
    'gold':[rgb(h) for h in ('cf980f','c4870c','dcaa1e','b0760d','e2b425','9c6a10')],
    'orange':[rgb(h) for h in ('c4561a','b1461a','d4731e','9e3c12','dd8a26','c96a18')],
    'amber':[rgb(h) for h in ('b8741c','a8661a','c98424','93561a','d0922e','9a7a22')],
    'green':[rgb(h) for h in ('446c22','37601e','527c29','5b8228','3c6722','6b8a2a')],
    'conifer':[rgb(h) for h in ('23402a','2c4a2e','1f3824','31522f','274530')],
    'birch':[rgb(h) for h in ('e6c84a','d8b640','f0d661','c9a834')],
    'shrub':[rgb(h) for h in ('35602a','2d5224','44702f','3a6428')],
    'shrub_red':[rgb(h) for h in ('9c3f22','b0512a','873520','a8602c')],
}

def deciduous(palette,seed):
    rng=random.Random(seed);m=PropMesh();pal=PALETTES[palette]
    m.prism(0,0,-.1,4.6,.28,.14,6,TRUNK,top=False)
    # A dark core fills the gaps; small clumps scattered over an ellipsoid give the broken crown.
    crown=((0,0,5.9),(3.2,3.2,2.9));top=8.9
    _lump(m,rng,(0,0,5.8),2.2,[_shade(c,.55) for c in pal],.95,(3.2,top),volume=crown)
    for i in range(13):
        u=rng.uniform(-.55,1);a=rng.uniform(0,2*math.pi);s=math.sqrt(1-u*u)
        c=(math.cos(a)*s*2.45,math.sin(a)*s*2.45,5.9+u*2.2)
        _lump(m,rng,c,rng.uniform(.85,1.25),pal,.9,(3.2,top),subdivisions=0,volume=crown)
    return m

def conifer(seed):
    rng=random.Random(seed);m=PropMesh();pal=PALETTES['conifer']
    m.prism(0,0,-.1,2.2,.24,.18,6,TRUNK,top=False)
    tiers=[(1.5,3.9,2.7),(3.6,3.6,2.2),(5.6,3.3,1.7),(7.5,3.2,1.15),(9.3,2.6,.7)]
    for z,h,r in tiers:
        seg=9;ring=[2*math.pi*(i+rng.uniform(-.15,.15))/seg for i in range(seg)]
        apex=(rng.uniform(-.08,.08),rng.uniform(-.08,.08),z+h)
        for a0,a1 in zip(ring,ring[1:]+ring[:1]):
            p0=(math.cos(a0)*r,math.sin(a0)*r,z-rng.uniform(0,.25));p1=(math.cos(a1)*r,math.sin(a1)*r,z-rng.uniform(0,.25))
            n0=_unit((math.cos(a0)*h,math.sin(a0)*h,r));n1=_unit((math.cos(a1)*h,math.sin(a1)*h,r));na=_unit(((n0[0]+n1[0])/2,(n0[1]+n1[1])/2,1.4))
            base=pal[rng.randrange(len(pal))];tip=_shade(pal[rng.randrange(len(pal))],1.35)
            m.tri_n(p0,p1,apex,n0,n1,na,_shade(base,.7),_shade(base,.72),tip)
            # Underside skirt: the tier reads as a solid layer from low camera angles.
            m.tri_n(p1,p0,(0,0,z+.5),(0,0,-1),(0,0,-1),(0,0,-1),_shade(base,.45),_shade(base,.45),_shade(base,.4))
    return m

def birch(seed):
    rng=random.Random(seed);m=PropMesh();pal=PALETTES['birch']
    bark=rgb('e4e0d6');mark=rgb('3b3833')
    z=-.1
    for i in range(6):
        z1=z+rng.uniform(.8,1.3);r0=.17-.012*i;m.prism(0,0,z,z1,r0,r0-.012,6,mark if i%2 and rng.random()<.6 else bark,top=False);z=z1
    for i in range(3):
        ang=2*math.pi*i/3+rng.uniform(-.5,.5)
        _lump(m,rng,(math.cos(ang)*.9,math.sin(ang)*.9,rng.uniform(5.4,7.2)),rng.uniform(1.25,1.6),pal,1.15,(4.2,9.0))
    _lump(m,rng,(0,0,8.0),1.2,pal,1.1,(4.2,9.0))
    return m

def shrub(palette,seed):
    rng=random.Random(seed);m=PropMesh()
    _lump(m,rng,(0,0,.62),.95,PALETTES[palette],.72,(0,1.3))
    _lump(m,rng,(.55,.2,.5),.62,PALETTES[palette],.75,(0,1.3))
    return m

# ---------------------------------------------------------------- buildings

GLASS=rgb('26313a');FRAME=rgb('f1efe8');DOOR=rgb('5b3b27');PLINTH=rgb('a8a196');CHIMNEY=rgb('7d4535');PANEL=rgb('1c2a45');GARAGE=rgb('8d8c86')

def _window(m,a,b,z0,z1,outward,frame=FRAME,glass=GLASS,inset=.12):
    """Window on a wall running a->b (plan points), raised slightly off the facade."""
    ox,oy=outward[0]*.04,outward[1]*.04
    m.face([(a[0]+ox,a[1]+oy,z0),(b[0]+ox,b[1]+oy,z0),(b[0]+ox,b[1]+oy,z1),(a[0]+ox,a[1]+oy,z1)],frame,(*outward,0))
    dx,dy=b[0]-a[0],b[1]-a[1];L=math.hypot(dx,dy);ux,uy=dx/L,dy/L;ox,oy=outward[0]*.06,outward[1]*.06
    aa=(a[0]+ux*inset+ox,a[1]+uy*inset+oy);bb=(b[0]-ux*inset+ox,b[1]-uy*inset+oy)
    m.face([(aa[0],aa[1],z0+inset),(bb[0],bb[1],z0+inset),(bb[0],bb[1],z1-inset),(aa[0],aa[1],z1-inset)],glass,(*outward,0))

def _row_windows(m,x0,y0,x1,y1,outward,z0,z1,width,spacing,skip=()):
    L=math.hypot(x1-x0,y1-y0);n=max(1,int((L-1)/spacing))
    ux,uy=(x1-x0)/L,(y1-y0)/L
    for i in range(n):
        c=(i+.5)*L/n
        if any(abs(c-s)<width for s in skip):continue
        a=(x0+ux*(c-width/2),y0+uy*(c-width/2));b=(x0+ux*(c+width/2),y0+uy*(c+width/2))
        _window(m,a,b,z0,z1,outward)

def _box_windows(m,x0,y0,x1,y1,z0,z1,width=1.2,spacing=3.0,front_skip=()):
    _row_windows(m,x0,y0,x1,y0,(0,-1),z0,z1,width,spacing,front_skip)
    _row_windows(m,x1,y1,x0,y1,(0,1),z0,z1,width,spacing)
    _row_windows(m,x1,y0,x1,y1,(1,0),z0,z1,width,spacing)
    _row_windows(m,x0,y1,x0,y0,(-1,0),z0,z1,width,spacing)

def _gable_roof(m,x0,y0,x1,y1,ze,pitch,oh,roof,gable,ridge='x'):
    """Gable roof over a rectangle; ridge along x or y; gable walls filled in wall colour."""
    t=math.tan(math.radians(pitch))
    if ridge=='x':
        ym=(y0+y1)/2;zr=ze+(y1-y0)/2*t;zo=ze-oh*t
        X0,X1=x0-oh,x1+oh
        for ya,sgn in ((y0-oh,-1),(y1+oh,1)):
            m.face([(X0,ya,zo),(X1,ya,zo),(X1,ym,zr),(X0,ym,zr)],roof,(0,sgn,1))
            m.face([(X0,ya,zo),(X1,ya,zo),(X1,ym,zr),(X0,ym,zr)],_shade(roof,.6),(0,-sgn,-1))
            m.face([(X0,ya,zo),(X1,ya,zo),(X1,ya,zo-.18),(X0,ya,zo-.18)],FRAME,(0,sgn,0))
        for x,sgn in ((x0,-1),(x1,1)):m.face([(x,y0,ze),(x,y1,ze),(x,ym,zr)],gable,(sgn,0,0))
        return lambda x,y:zr-abs(y-ym)*t
    xm=(x0+x1)/2;zr=ze+(x1-x0)/2*t;zo=ze-oh*t
    Y0,Y1=y0-oh,y1+oh
    for xa,sgn in ((x0-oh,-1),(x1+oh,1)):
        m.face([(xa,Y0,zo),(xa,Y1,zo),(xm,Y1,zr),(xm,Y0,zr)],roof,(sgn,0,1))
        m.face([(xa,Y0,zo),(xa,Y1,zo),(xm,Y1,zr),(xm,Y0,zr)],_shade(roof,.6),(-sgn,0,-1))
        m.face([(xa,Y0,zo),(xa,Y1,zo),(xa,Y1,zo-.18),(xa,Y0,zo-.18)],FRAME,(sgn,0,0))
    for y,sgn in ((y0,-1),(y1,1)):m.face([(x0,y,ze),(x1,y,ze),(xm,y,zr)],gable,(0,sgn,0))
    return lambda x,y:zr-abs(x-xm)*t

def _hip_roof(m,x0,y0,x1,y1,ze,pitch,oh,roof):
    """Hip roof, ridge along the long x side (x1-x0 >= y1-y0)."""
    t=math.tan(math.radians(pitch));d=(y1-y0)/2;ym=(y0+y1)/2;zr=ze+d*t;zo=ze-oh*t
    X0,X1,Y0,Y1=x0-oh,x1+oh,y0-oh,y1+oh;r0,r1=x0+d,x1-d
    faces=[([(X0,Y0,zo),(X1,Y0,zo),(r1,ym,zr),(r0,ym,zr)],(0,-1,1)),([(X1,Y1,zo),(X0,Y1,zo),(r0,ym,zr),(r1,ym,zr)],(0,1,1)),
           ([(X0,Y1,zo),(X0,Y0,zo),(r0,ym,zr)],(-1,0,1)),([(X1,Y0,zo),(X1,Y1,zo),(r1,ym,zr)],(1,0,1))]
    for pts,n in faces:
        m.face(pts,roof,n);m.face(pts,_shade(roof,.6),(-n[0],-n[1],-1))
    for (ax,ay),(bx,by),n in [((X0,Y0),(X1,Y0),(0,-1)),((X1,Y1),(X0,Y1),(0,1)),((X0,Y1),(X0,Y0),(-1,0)),((X1,Y0),(X1,Y1),(1,0))]:
        m.face([(ax,ay,zo),(bx,by,zo),(bx,by,zo-.18),(ax,ay,zo-.18)],FRAME,(*n,0))
    return lambda x,y:zr-max(0,abs(y-ym))*t if r0<=x<=r1 else zr-max(abs(y-ym),min(abs(x-r0),abs(x-r1)))*t

def _solar(m,height_at,xs,ys,slope_normal,cols=4,rows=2,w=1.05,h=1.7):
    """Panel array lying on a roof plane; height_at gives the roof surface under a plan point."""
    x0,y0=xs;step_x=w+.08;step_y=h+.08
    for i in range(cols):
        for j in range(rows):
            a=x0+i*step_x;b=y0+j*step_y*ys
            pts=[(a,b),(a+w,b),(a+w,b+h*ys),(a,b+h*ys)]
            m.face([(x,y,height_at(x,y)+.09) for x,y in pts],PANEL,slope_normal)

def _porch(m,x0,x1,y,depth,z,roof,post=FRAME):
    m.cuboid(x0,y-depth,-.3,x1,y,.3,PLINTH)
    for x in (x0+.15,x1-.3):m.cuboid(x,y-depth+.1,.3,x+.15,y-depth+.25,z,post)
    m.cuboid(x0-.15,y-depth-.2,z,x1+.15,y,z+.18,FRAME,top=roof)
    m.cuboid((x0+x1)/2-.8,y-depth-.9,-.3,(x0+x1)/2+.8,y-depth,.15,PLINTH)

def _door(m,x,y,z1=2.2,w=1.0,color=DOOR):
    m.face([(x-w/2-.1,y-.05,.3),(x+w/2+.1,y-.05,.3),(x+w/2+.1,y-.05,z1+.1),(x-w/2-.1,y-.05,z1+.1)],FRAME,(0,-1,0))
    m.face([(x-w/2,y-.07,.3),(x+w/2,y-.07,.3),(x+w/2,y-.07,z1),(x-w/2,y-.07,z1)],color,(0,-1,0))

def _garage_door(m,x0,x1,y,z1=2.4):
    m.face([(x0,y-.05,.05),(x1,y-.05,.05),(x1,y-.05,z1),(x0,y-.05,z1)],GARAGE,(0,-1,0))
    for k in range(1,5):
        z=.05+k*(z1-.05)/5;m.face([(x0,y-.07,z-.04),(x1,y-.07,z-.04),(x1,y-.07,z),(x0,y-.07,z)],_shade(GARAGE,.7),(0,-1,0))

def house_gable(wall,roof,solar=False):
    m=PropMesh();W,D,H=12.0,9.0,3.1;x0,y0,x1,y1=-W/2,-D/2,W/2,D/2
    m.cuboid(x0-.1,y0-.1,-.4,x1+.1,y1+.1,.35,PLINTH)
    m.cuboid(x0,y0,.35,x1,y1,H,wall)
    _box_windows(m,x0,y0,x1,y1,1.05,2.45,1.3,3.2,front_skip=(4.5,))
    _door(m,-1.5,y0);_porch(m,-3.2,.2,y0,1.8,2.7,roof)
    h=_gable_roof(m,x0,y0,x1,y1,H,32,.55,roof,wall,'x')
    m.cuboid(3.0,1.2,H,3.8,2.0,h(3.4,1.6)+1.3,CHIMNEY,top=_shade(CHIMNEY,.6))
    if solar:_solar(m,h,(-4.8,y0+.35),1,(0,-1,1.6),cols=5,rows=2)
    return m

def house_cottage(wall,roof):
    """Compact one-storey cottage for shallow or narrow lots."""
    m=PropMesh();W,D,H=9.5,7.5,2.9;x0,y0,x1,y1=-W/2,-D/2,W/2,D/2
    m.cuboid(x0-.1,y0-.1,-.4,x1+.1,y1+.1,.35,PLINTH)
    m.cuboid(x0,y0,.35,x1,y1,H,wall)
    _box_windows(m,x0,y0,x1,y1,1.0,2.3,1.2,3.0,front_skip=(3.3,))
    _door(m,-1.45,y0);m.cuboid(-2.5,y0-1.2,2.45,-.4,y0,2.62,FRAME,top=roof)
    m.cuboid(-2.4,y0-1.4,-.3,-.5,y0,.2,PLINTH)
    h=_gable_roof(m,x0,y0,x1,y1,H,36,.45,roof,wall,'x')
    m.cuboid(2.2,.9,H,2.9,1.6,h(2.5,1.2)+1.1,CHIMNEY,top=_shade(CHIMNEY,.6))
    return m

def house_hip(wall,roof,solar=False):
    m=PropMesh();W,D,H=14.0,10.0,3.1;x0,y0,x1,y1=-W/2,-D/2,W/2,D/2
    m.cuboid(x0-.1,y0-.1,-.4,x1+.1,y1+.1,.35,PLINTH)
    m.cuboid(x0,y0,.35,x1,y1,H,wall)
    _box_windows(m,x0,y0,x1,y1,1.05,2.45,1.4,3.0,front_skip=(4.8,11.0,12.3))
    _door(m,-2.2,y0);_garage_door(m,3.4,6.4,y0)
    m.cuboid(-3.4,y0-1.4,2.55,-1.0,y0,2.72,FRAME,top=roof)
    h=_hip_roof(m,x0,y0,x1,y1,H,26,.6,roof)
    if solar:_solar(m,h,(-3.0,y0+.1),1,(0,-1,2.0),cols=5,rows=2)
    else:m.cuboid(-4.2,1.6,H,-3.4,2.4,h(-3.8,2.0)+1.1,CHIMNEY,top=_shade(CHIMNEY,.6))
    return m

def house_two(wall,roof,solar=False):
    """Two-storey gable-to-street block with a one-storey garage wing (the white house in the reference)."""
    m=PropMesh();H=5.8
    x0,y0,x1,y1=-7.5,-5.0,1.5,5.0
    m.cuboid(x0-.1,y0-.1,-.4,7.5+.1,y1+.1,.35,PLINTH)
    m.cuboid(x0,y0,.35,x1,y1,H,wall)
    for z0,z1 in ((1.05,2.45),(3.7,5.05)):
        _row_windows(m,x0,y0,x1,y0,(0,-1),z0,z1,1.2,2.9,(4.5,) if z0<2 else ())
        _row_windows(m,x1,y1,x0,y1,(0,1),z0,z1,1.2,2.9)
        _row_windows(m,x0,y1,x0,y0,(-1,0),z0,z1,1.2,3.1)
    _door(m,-3.0,y0);_porch(m,x0-.2,x1+.2,y0,2.2,2.8,roof)
    h=_gable_roof(m,x0,y0,x1,y1,H,42,.45,roof,wall,'y')
    # Attic window in the street gable.
    _window(m,(-3.6,y0-.02),(-2.4,y0-.02),6.4,7.6,(0,-1))
    gx0,gy0,gx1,gy1=1.5,-3.5,7.5,4.0
    m.cuboid(gx0,gy0,.35,gx1,gy1,3.0,wall)
    _garage_door(m,2.4,6.6,gy0,2.5)
    _row_windows(m,gx1,gy0,gx1,gy1,(1,0),1.1,2.3,1.2,3.0)
    _gable_roof(m,gx0,gy0,gx1,gy1,3.0,28,.45,roof,wall,'x')
    m.cuboid(-6.6,2.6,H,-5.8,3.4,h(-6.2,3.0)+1.2,CHIMNEY,top=_shade(CHIMNEY,.6))
    if solar:_solar(m,h,(x1-.35-3*1.13,-3.8),1,(1,0,1.1),cols=3,rows=3,w=1.05,h=1.7)
    return m

def house_modern(wall,accent,roof):
    """Flat-roofed split volumes with timber cladding, like the brown modern house in the reference."""
    m=PropMesh()
    m.cuboid(-7.1,-4.6,-.4,7.1,4.6,.35,PLINTH)
    m.cuboid(-7.0,-4.5,.35,1.0,4.5,3.4,wall)
    m.cuboid(1.0,-3.0,.35,7.0,4.5,6.3,accent)
    for x0,y0,x1,y1,z in ((-7.5,-5.1,1.3,5.0,3.4),(.7,-3.6,7.5,5.0,6.3)):
        m.cuboid(x0,y0,z,x1,y1,z+.32,_shade(roof,1.3),top=roof)
    _window(m,(-3.0,-4.5),(-1.2,-4.5),.9,2.7,(0,-1))
    _garage_door(m,-6.2,-3.4,-4.5,2.6)
    _row_windows(m,1.0,-3.0,7.0,-3.0,(0,-1),3.7,5.6,2.6,3.0)
    _row_windows(m,7.0,-3.0,7.0,4.5,(1,0),1.0,2.7,1.8,3.2);_row_windows(m,7.0,-3.0,7.0,4.5,(1,0),3.8,5.6,1.8,3.2)
    _row_windows(m,1.0,4.5,-7.0,4.5,(0,1),.9,2.7,2.4,3.2)
    _door(m,-.4,-4.5,2.4,1.1,rgb('2e2a26'))
    _solar(m,lambda x,y:3.72,(-6.4,-3.6),1,(0,0,1),cols=5,rows=3,w=1.05,h=1.7)
    return m

def workshop(wall,band,roof):
    """Light industrial shed: low-pitch roof, ribbon glazing, loading doors, rooftop units."""
    m=PropMesh();W,D,H=19.0,15.0,7.5;x0,y0,x1,y1=-W/2,-D/2,W/2,D/2
    m.cuboid(x0-.1,y0-.1,-.4,x1+.1,y1+.1,.2,PLINTH)
    m.cuboid(x0,y0,.2,x1,y1,H,wall)
    for (ax,ay),(bx,by),n in [((x0,y0),(x1,y0),(0,-1)),((x1,y1),(x0,y1),(0,1)),((x1,y0),(x1,y1),(1,0)),((x0,y1),(x0,y0),(-1,0))]:
        o=(n[0]*.05,n[1]*.05)
        m.face([(ax+o[0],ay+o[1],H-1.2),(bx+o[0],by+o[1],H-1.2),(bx+o[0],by+o[1],H-.3),(ax+o[0],ay+o[1],H-.3)],band,(*n,0))
        _window(m,(ax,ay),(bx,by),4.9,6.2,n,frame=band,inset=.25)
    for x in (-7.8,-2.6):_garage_door(m,x,x+4.0,y0,4.4)
    _door(m,4.5,y0,2.3,1.1,band)
    t=math.tan(math.radians(7));zr=H+D/2*t
    for ya,sgn in ((y0-.3,-1),(y1+.3,1)):
        pts=[(x0-.3,ya,H-.3*t),(x1+.3,ya,H-.3*t),(x1+.3,0,zr),(x0-.3,0,zr)]
        m.face(pts,roof,(0,sgn,1));m.face(pts,_shade(roof,.6),(0,-sgn,-1))
    for x in (x0,x1):m.face([(x,y0,H),(x,y1,H),(x,0,zr)],wall,(math.copysign(1,x),0,0))
    for x,y in ((-5,2.5),(-1.5,3),(3.5,3.2)):m.cuboid(x,y,H+ (D/2-y)*t-.1,x+1.8,y+1.4,H+(D/2-y)*t+1.1,rgb('b9bcbf'))
    return m

# Wall/roof pairs chosen from the reference palette: cream, white, butter yellow, blue-grey, sage, timber.
HOUSES={
    'house_gable_cream':(house_gable,(rgb('efe4c8'),rgb('2d2f33'))),
    'house_gable_yellow':(house_gable,(rgb('e7cf7e'),rgb('4a3a31'),True)),
    'house_hip_white':(house_hip,(rgb('f1efe9'),rgb('34373b'),True)),
    'house_hip_grey':(house_hip,(rgb('b3bcc0'),rgb('3e3a37'))),
    'house_two_white':(house_two,(rgb('f3f1ea'),rgb('26282b'))),
    'house_two_sage':(house_two,(rgb('b7c09c'),rgb('4b3b33'),True)),
    'house_modern_timber':(house_modern,(rgb('d9d4c7'),rgb('8a5a3b'),rgb('2b2c2e'))),
    'house_modern_grey':(house_modern,(rgb('ecebe6'),rgb('6d6a66'),rgb('2b2c2e'))),
    'house_cottage_blue':(house_cottage,(rgb('a9bccb'),rgb('2f3136'))),
    'house_cottage_cream':(house_cottage,(rgb('eadcc0'),rgb('5a4034'))),
}
WORKSHOPS={
    'workshop_white':(workshop,(rgb('e6e6e1'),rgb('5f7a8c'),rgb('c3c7ca'))),
    'workshop_sand':(workshop,(rgb('d8d0c0'),rgb('8a6a4a'),rgb('9ea3a8'))),
}
KINDS=('house_gable','house_hip','house_two','house_modern','house_cottage','workshop')
# Local x of the garage/driveway centre, or None for a street-facing carport path along the side.
DRIVEWAY_X={'house_gable':None,'house_hip':4.9,'house_two':4.5,'house_modern':-4.8,'house_cottage':None,'workshop':-3.9}
DOOR_X={'house_gable':-1.5,'house_hip':-2.2,'house_two':-3.0,'house_modern':-.4,'house_cottage':-1.45,'workshop':4.5}
TREES={'tree_gold':lambda:deciduous('gold',11),'tree_orange':lambda:deciduous('orange',23),'tree_amber':lambda:deciduous('amber',37),
       'tree_green':lambda:deciduous('green',41),'conifer':lambda:conifer(5),'birch':lambda:birch(7),
       'shrub':lambda:shrub('shrub',3),'shrub_red':lambda:shrub('shrub_red',9)}

def kind(name):return next(k for k in KINDS if name.startswith(k))

def footprint(mesh):
    """Plan bounding box (xmin, ymin, xmax, ymax) of a prop, read back from its vertices (glTF y-up)."""
    xs=mesh.v[0::3];ys=[-z for z in mesh.v[2::3]]
    return (min(xs),min(ys),max(xs),max(ys))

def build_props(assets):
    """Write every prop GLB; returns {name: {'triangles', 'bbox'}}."""
    out={}
    for name,make in TREES.items():out[name]=make()
    for name,(fn,args) in {**HOUSES,**WORKSHOPS}.items():out[name]=fn(*args)
    stats={}
    for name,mesh in out.items():
        info=mesh.save(assets/(name+'.glb'),roughness=.85)
        stats[name]={'triangles':info['triangles'],'bbox':[round(v,3) for v in footprint(mesh)]}
    return stats
