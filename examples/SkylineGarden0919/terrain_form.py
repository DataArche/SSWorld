"""Shared designed terrain datum; flat city plateau, detailed outer hills."""
import math
STEP=20
def raw_height(x,y):
    if y<455:
        # Keep the complete road network and built city on its existing datum.
        outside=max(0,abs(x)-920,-y-770)
        f=min(1,outside/180)
        return f*(4+3*math.sin(x*.013)*math.cos(y*.011)+2*math.sin(x*.031+y*.02))
    if y<505:return -(y-455)*.18
    if y<635:return -9
    if y<690:return -9+(y-635)*.17
    t=min(1,(y-690)/250)
    broad=32+100*math.sin(x*.0029+y*.002)**2+180*math.exp(-((x+600)**2+(y-1250)**2)/380000)+160*math.exp(-((x-800)**2+(y-1650)**2)/500000)+17*math.sin(x*.009)*math.cos(y*.01)
    detail=14*math.sin(x*.019+y*.008)*math.cos(y*.022)+6*math.sin(x*.043-y*.027)+3*math.cos(x*.091+y*.073)
    return t*(broad+detail)

def height(x,y):
    # Interpolate the same sampled 20 m grid used by HeightField.
    gx=(x+2400)/STEP;gy=(y+1100)/STEP;ix=math.floor(gx);iy=math.floor(gy);u=gx-ix;v=gy-iy
    x0=-2400+ix*STEP;y0=-1100+iy*STEP
    a,b,c,d=[round(raw_height(xx,yy),2) for xx,yy in [(x0,y0),(x0+STEP,y0),(x0,y0+STEP),(x0+STEP,y0+STEP)]]
    return (1-v)*(a*(1-u)+b*u)+v*(c*(1-u)+d*u)

def park_clear(x,y,margin=.9):
    r=math.hypot(x,y)
    if abs(x)>64 or abs(y)>64:return False
    if 42-margin<r<48+margin:return False
    if min(abs(x),abs(y))<2.5+margin:return False
    if max(abs(x),abs(y))<16+margin:return False
    if -34-margin<x<-18+margin and 18-margin<y<30+margin:return False
    if math.hypot(x-27,y-23)<10+margin:return False
    for i in range(8):
        a=(i+.5)*math.pi/4
        if math.hypot(x-36*math.cos(a),y-36*math.sin(a))<3.2+margin:return False
    for a in (math.pi/4,3*math.pi/4,5*math.pi/4,7*math.pi/4):
        dx=x-26*math.cos(a);dy=y-26*math.sin(a)
        u=dx*math.cos(a)+dy*math.sin(a);v=-dx*math.sin(a)+dy*math.cos(a)
        if abs(u)<4.5+margin and abs(v)<2.5+margin:return False
    return True
