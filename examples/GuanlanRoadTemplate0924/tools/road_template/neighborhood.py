"""Illustrative infill for the generated frontage parcels: houses facing the street, driveways,
hedges/fences, yard trees, plus woodland on unparcelled ground and a forest belt past the AOI.

Nothing here is observed data; the report labels it illustrative and the page can hide it.
"""
import math,random
import numpy as np
from shapely import contains_xy,prepare
from shapely.geometry import Polygon,LineString,Point
from shapely.geometry.polygon import orient
from .geometry import polygons,lines,union
from .props import HOUSES,WORKSHOPS,DRIVEWAY_X,DOOR_X,kind

HARD_USES=('industrial','construction','brownfield','retail')

def _frame(center,theta):
    """Local prop frame -> world: x along the frontage, -y toward the road."""
    c,s=math.cos(theta),math.sin(theta);cx,cy=center
    return lambda x,y:(cx+x*c-y*s,cy+x*s+y*c)

def _rect(to_world,x0,y0,x1,y1):
    return Polygon([to_world(x0,y0),to_world(x1,y0),to_world(x1,y1),to_world(x0,y1)])

def frontage(parcel,zone):
    """Longest parcel edge along the sidewalk buffer: (midpoint, unit tangent, inward normal, edge)."""
    g=orient(parcel,sign=1);coords=list(g.exterior.coords);best=None
    for a,b in zip(coords,coords[1:]):
        seg=LineString([a,b]);inside=seg.intersection(zone).length
        if seg.length>.5 and (best is None or inside>best[0]):best=(inside,a,b,seg)
    _,a,b,seg=best;L=seg.length;t=((b[0]-a[0])/L,(b[1]-a[1])/L)
    part=seg.intersection(zone);mid=(part if not part.is_empty else seg).centroid
    return (mid.x,mid.y),t,(-t[1],t[0]),seg

def _noise(x,y,seed):
    """Smooth deterministic field in [0,1] for clumping woodland and species stands."""
    r=random.Random(seed);v=0;w=0
    for k in range(4):
        f=r.uniform(.004,.02)*(1.7**k);a=r.uniform(0,6.28);ph=r.uniform(0,6.28);amp=.6**k
        v=v+amp*np.sin((x*math.cos(a)+y*math.sin(a))*f+ph);w+=amp
    return .5+.5*v/w

def _pick(rng,weights):
    total=sum(weights.values());r=rng.uniform(0,total)
    for k,w in weights.items():
        r-=w
        if r<=0:return k
    return k

def plan(parcels,net,landuse,buildings,water,aoi,props,config):
    cfg=config.get('infill',{});rng=random.Random(config['seed']+7)
    zone=net['sidewalks'].buffer(2.3);keepout=buildings.buffer(1.5).union(water.buffer(1))
    hard=union([g for use,g in landuse if use in HARD_USES]);prepare(hard)
    placed=[];drives=[];paths=[];aprons=[];hedge_lines=[];fence_lines=[];front_hedges=[];yard=[];skipped=0
    house_names=list(HOUSES);work_names=list(WORKSHOPS)
    for p in parcels:
        g=p['geom']
        if rng.random()>cfg.get('build_share',.9):skipped+=1;yard.append(('garden',g,None));continue
        mid,t,n,edge=frontage(g,zone)
        industrial=hard.contains(g.representative_point())
        names=work_names if industrial else house_names
        # Full-size models first in random order; tight lots fall back to cottages, then scaled copies.
        order=sorted(names,key=lambda nm:(nm.startswith('house_cottage'),rng.random()))
        theta=math.atan2(t[1],t[0]);inner=g.buffer(-.9);done=None
        shifts=(rng.uniform(-2.5,2.5),0,-4,4,-7,7)
        for scale in (1,.88,.78):
            for name in order:
                x0,y0,x1,y1=[v*scale for v in props[name]['bbox']]
                for setback in cfg.get('setbacks',[7.5,6,4.5,3]):
                    for shift in shifts:
                        # Front face (local ymin) sits `setback` metres behind the frontage edge.
                        center=(mid[0]+n[0]*(setback-y0)+t[0]*shift,mid[1]+n[1]*(setback-y0)+t[1]*shift)
                        to_world=_frame(center,theta);rect=_rect(to_world,x0,y0,x1,y1)
                        if inner.contains(rect) and not rect.intersects(keepout):done=(name,scale,center,to_world,rect,setback);break
                    if done:break
                if done:break
            if done:break
        if not done:skipped+=1;yard.append(('garden',g,None));continue
        name,scale,center,to_world,rect,setback=done;k=kind(name);x0,y0,x1,y1=[v*scale for v in props[name]['bbox']]
        placed.append({'parcel':p['id'],'model':name,'scale':scale,'position':center,'rotation_z':math.degrees(theta),'footprint':rect})
        reach=setback+2.6  # across the planted setback to the sidewalk
        if k=='workshop':aprons.append(_rect(to_world,x0-1,y0-reach,x1+1,y0))
        else:
            dx=DRIVEWAY_X[k]
            if dx is None:dx=x1+1.9;drives.append(_rect(to_world,dx-1.5,y0-reach,dx+1.5,y0+5))
            else:dx*=scale;drives.append(_rect(to_world,dx-1.6,y0-reach,dx+1.6,y0+.2))
            door=DOOR_X[k]*scale;paths.append(_rect(to_world,door-.6,y0-reach,door+.6,y0+.2))
        # Hedges on side and rear edges (the frontage edge stays open); some parcels get a picket fence.
        ring=orient(g,sign=1).exterior;coords=list(ring.coords)
        sides=[LineString([a,b]) for a,b in zip(coords,coords[1:]) if LineString([a,b]).intersection(zone).length<.5*LineString([a,b]).length]
        (hedge_lines if rng.random()<.78 else fence_lines).extend(sides)
        if k!='workshop' and rng.random()<cfg.get('front_hedge_share',.4):front_hedges.append(edge)
        yard.append(('house',g,rect))
    return {'placed':placed,'drives':drives,'paths':paths,'aprons':aprons,'hedge_lines':hedge_lines,
            'fence_lines':fence_lines,'front_hedges':front_hedges,'yards':yard,'skipped':skipped}

def surfaces(layout,net):
    """Hardscape and boundary planting polygons, clipped off roads, sidewalks and houses."""
    road=net['asphalt'].union(net['sidewalks'])
    houses=union([h['footprint'] for h in layout['placed']])
    drives=union(layout['drives']).difference(road)
    paths=union(layout['paths']).difference(road).difference(drives)
    aprons=union(layout['aprons']).difference(road)
    gaps=union([drives.buffer(.6),paths.buffer(.4),aprons.buffer(.6),houses.buffer(1.2),road.buffer(.3)])
    hedges=union([ln.buffer(.45,cap_style=2) for ln in layout['hedge_lines']]).difference(gaps)
    front=union([ln.offset_curve(1.1).buffer(.4,cap_style=2) for ln in layout['front_hedges'] if ln.length>1]).difference(gaps)
    fences=union([ln.buffer(.05,cap_style=2) for ln in layout['fence_lines']]).difference(gaps).difference(hedges.buffer(.2))
    return {'drives':drives,'paths':paths,'aprons':aprons,'hedges':hedges,'front_hedges':front,'fences':fences}

SPECIES={'tree_gold':.26,'tree_orange':.2,'tree_amber':.12,'tree_green':.1,'conifer':.22,'birch':.1}

def yard_planting(layout,drives,rng):
    """Back-yard trees and front shrubs per built parcel; gardens get a small grove."""
    rows=[]
    for label,g,rect in layout['yards']:
        blocked=g.buffer(-1.6)
        if rect is not None:blocked=blocked.difference(rect.buffer(2.8)).difference(drives.buffer(1.5))
        if blocked.is_empty:continue
        want=rng.randint(1,3) if label=='house' else rng.randint(3,6);got=[];tries=0
        minx,miny,maxx,maxy=blocked.bounds
        while len(got)<want and tries<40:
            tries+=1;x,y=rng.uniform(minx,maxx),rng.uniform(miny,maxy)
            if blocked.contains(Point(x,y)) and all(math.hypot(x-a,y-b)>5.5 for a,b in got):got.append((x,y))
        for x,y in got:rows.append((_pick(rng,SPECIES),x,y,rng.uniform(.75,1.15)))
        if rect is not None:
            ring=list(rect.exterior.coords)
            for a,b in zip(ring[:1],ring[1:2]):  # front edge of the footprint
                for f in (.12,.3,.7,.88):
                    if rng.random()<.55:
                        x=a[0]+(b[0]-a[0])*f;y=a[1]+(b[1]-a[1])*f
                        cx,cy=rect.centroid.x,rect.centroid.y;d=math.hypot(x-cx,y-cy) or 1
                        x+=(x-cx)/d*1.3;y+=(y-cy)/d*1.3
                        if not drives.buffer(.8).contains(Point(x,y)):rows.append(('shrub' if rng.random()<.65 else 'shrub_red',x,y,rng.uniform(.8,1.25)))
    return rows

def woodland(region,spacing,seed,density=.55,max_count=None):
    """Clumped woodland on a jittered grid: stands of conifers and autumn broadleaves with clearings."""
    if region.is_empty:return []
    rng=np.random.default_rng(seed);minx,miny,maxx,maxy=region.bounds
    gx,gy=np.meshgrid(np.arange(minx,maxx,spacing),np.arange(miny,maxy,spacing))
    x=gx.ravel()+rng.uniform(-.42,.42,gx.size)*spacing;y=gy.ravel()+rng.uniform(-.42,.42,gy.size)*spacing
    prepare(region);keep=contains_xy(region,x,y);x,y=x[keep],y[keep]
    clump=_noise(x,y,seed);keep=rng.random(x.size)<np.clip((clump-.5+density)*1.6,0,1);x,y=x[keep],y[keep]
    stand=_noise(x,y,seed+1);pick=rng.random(x.size)
    rows=[]
    for i in range(x.size):
        if stand[i]<.4:name='conifer' if pick[i]<.8 else 'tree_gold'
        elif stand[i]<.55:name=['conifer','tree_gold','tree_orange','birch'][int(pick[i]*4)]
        else:name=['tree_gold','tree_gold','tree_orange','tree_amber','tree_green','birch'][int(pick[i]*6)]
        rows.append((name,float(x[i]),float(y[i]),float(rng.uniform(.8,1.3))))
    if max_count and len(rows)>max_count:
        idx=np.random.default_rng(seed+2).choice(len(rows),max_count,replace=False);rows=[rows[i] for i in sorted(idx)]
    return rows

def street_species(road_id,rng):
    """Each street gets a dominant species with some variety, the way real street planting reads."""
    h=sum(map(ord,str(road_id)))
    main=['tree_gold','tree_orange','tree_amber','tree_green','birch','tree_gold'][h%6]
    return main if rng.random()<.78 else _pick(rng,{k:v for k,v in SPECIES.items() if k!='conifer'})
