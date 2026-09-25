"""Metric geometry only. Geographic projection lives exclusively in engine_project.mjs."""
import math
from collections import defaultdict
from shapely import make_valid, set_precision, line_merge
from shapely.geometry import Polygon, LineString, Point, GeometryCollection
from shapely.ops import unary_union, linemerge

EMPTY=GeometryCollection()

def polygons(g):
    if g.is_empty: return []
    if g.geom_type=='Polygon': return [g]
    return [p for c in getattr(g,'geoms',[]) for p in polygons(c)]

def lines(g):
    if g.is_empty: return []
    if g.geom_type in ('LineString','LinearRing'): return [LineString(g)]
    return [p for c in getattr(g,'geoms',[]) for p in lines(c)]

def union(gs):
    return unary_union([g for g in gs if not g.is_empty])

def clean(g):
    # Boolean clipping can leave zero-area lines/points; surface consumers require polygons.
    return union(polygons(set_precision(make_valid(g),.001)))

def num(v,default=None):
    try:return float(str(v).split(';')[0].replace(' m',''))
    except (TypeError,ValueError):return default

def tangent(ln,d,delta=.5):
    a=ln.interpolate(max(0,d-delta)); b=ln.interpolate(min(ln.length,d+delta))
    dx,dy=b.x-a.x,b.y-a.y; length=math.hypot(dx,dy)
    return (dx/length,dy/length) if length>1e-8 else (1,0)

def stripe(center, direction, length,width):
    dx,dy=direction; x,y=center
    return LineString([(x-dx*length/2,y-dy*length/2),(x+dx*length/2,y+dy*length/2)]).buffer(width/2,cap_style=2)

def junctions(roads):
    """Degree counts branches, not OSM ways; an unsplit through-way plus branch is degree 3."""
    nodes=defaultdict(lambda:{'neighbors':set(),'roads':set(),'width':0})
    for i,r in enumerate(roads):
        for ln in lines(r['geom']):
            coords=list(ln.coords)
            for a,b in zip(coords,coords[1:]):
                ka=tuple(round(v,2) for v in a); kb=tuple(round(v,2) for v in b)
                if ka==kb:continue
                for k,n in [(ka,kb),(kb,ka)]:
                    nodes[k]['neighbors'].add(n); nodes[k]['roads'].add(i)
                    nodes[k]['width']=max(nodes[k]['width'],r['width'])
    return [{'point':Point(k),'degree':len(n['neighbors']),'roads':sorted(n['roads']),'radius':n['width']/2+5}
            for k,n in nodes.items() if len(n['neighbors'])>=3]

def rounded_road_surface(raw,roads,junction_nodes,radius):
    """Fillet junctions and bends, including corners inside closed street blocks.

    Treat holes individually: freezing every hole also freezes block corners,
    while unconstrained closing can erase a narrow traffic island entirely.
    Reduce its fillet radius until each island stays connected and retains 90%
    of its area. Round buffers use 24 segments per quadrant for close-up views.
    """
    masks=[j['point'].buffer(j['radius']+radius) for j in junction_nodes]
    for rd in roads:
        for ln in lines(rd['geom']):
            cc=list(ln.coords)
            triples=list(zip(cc,cc[1:],cc[2:]))
            if ln.is_ring:triples.append((cc[-2],cc[0],cc[1]))
            for a,b,c in triples:
                u=(a[0]-b[0],a[1]-b[1]);v=(c[0]-b[0],c[1]-b[1])
                length=math.hypot(*u)*math.hypot(*v)
                if length and (u[0]*v[0]+u[1]*v[1])/length>-.995:
                    masks.append(Point(b).buffer(rd['width']/2+2*radius))
    mask=union(masks)
    patches=[]
    for p in polygons(raw):
        exterior=Polygon(p.exterior)
        rounded=exterior.buffer(radius,quad_segs=24).buffer(-radius,quad_segs=24)
        kept=[]
        for ring in p.interiors:
            island=Polygon(ring);r=radius
            for _ in range(16):
                candidate=island.buffer(-r,quad_segs=24).buffer(r,quad_segs=24).intersection(island)
                if candidate.geom_type=='Polygon' and candidate.area>=island.area*.9:
                    break
                r*=.5
            else:candidate=island
            kept.append(candidate)
        patches.append(rounded.difference(union(kept)).difference(p).intersection(mask))
    return union(patches)

def road_network(features,config,aoi,buildings,water):
    drive=[]; foot=[]; bridges=[]; crossings=[]; excluded=[]
    for f in features:
        p=f['properties']; uid=f.get('id',p.get('@id')); cls=p['highway']; g=f['_geom']
        if g.is_empty:continue
        ov=config.get('overrides',{}).get(uid,{})
        if p.get('tunnel')=='yes' or cls in ('steps','construction'):
            excluded.append({'id':uid,'reason':'tunnel, stairs or construction has no inferred road surface'});continue
        if p.get('bridge')=='yes':
            bridges.append({'id':uid,'geom':g,'class':cls});continue
        if p.get('footway')=='crossing' or p.get('cycleway')=='crossing' or 'crossing' in p:
            if p.get('crossing:markings')!='no' and p.get('crossing')!='unmarked':
                crossings.append({'id':uid,'geom':g,'source':'osm_crossing'})
            if cls in ('footway','cycleway'):continue
        if cls in ('footway','cycleway','path','pedestrian'):
            foot.append({'id':uid,'geom':g,'width':num(p.get('width'),2.1),'properties':p});continue
        if cls not in config['road_defaults']:
            excluded.append({'id':uid,'reason':f'highway={cls} has no road_defaults entry'});continue
        default=config['road_defaults'][cls]
        lanes=int(ov.get('lanes',num(p.get('lanes'),default['lanes'])))
        w=ov.get('width',num(p.get('width')))
        source='override' if 'width' in ov else 'osm_width'
        if w is None:
            w=lanes*config['lane_width']+2*config['shoulder'] if 'lanes' in p else default['width']
            source='lane_rule' if 'lanes' in p else 'class_rule'
        drive.append({'id':uid,'geom':g,'class':cls,'lanes':lanes,'width':w,'properties':p,'width_source':source})
    js=junctions(drive)
    if config.get('infer_local_crossings',False):
        # Optional design rule on minor streets only; source-tagged unmarked crossings take precedence.
        forbidden=union([f['_geom'].buffer(7) for f in features if f['properties'].get('crossing:markings')=='no' or f['properties'].get('crossing')=='unmarked'])
        for j in js:
            for ri in j['roads']:
                rd=drive[ri]
                if rd['class'] not in ('residential','unclassified'):continue
                for ln in lines(rd['geom']):
                    s=ln.project(j['point'])
                    if ln.distance(j['point'])>.05:continue
                    for sign in (-1,1):
                        d=s+sign*(j['radius']+1)
                        if d<2 or d>ln.length-2:continue
                        q=ln.interpolate(d); dx,dy=tangent(ln,d); half=rd['width']/2+3.2
                        if q.intersects(forbidden) or any(q.distance(c['geom'])<10 for c in crossings):continue
                        crossings.append({'id':f"design_crossing_{rd['id']}_{len(crossings)}",'geom':LineString([(q.x-dy*half,q.y+dx*half),(q.x+dy*half,q.y-dx*half)]),'source':'inferred_local_street_rule'})
    raw=union([r['geom'].buffer(r['width']/2,cap_style=2,join_style=1) for r in drive])
    patches=rounded_road_surface(raw,drive,js,config['corner_radius'])
    asphalt=clean(raw.union(patches).difference(buildings.buffer(.1)).difference(water).intersection(aoi))
    mapped_foot=union([r['geom'].buffer(r['width']/2,cap_style=2,join_style=1) for r in foot])
    # One surface union avoids duplicating independently mapped sidewalks.
    paved=asphalt.buffer(config['sidewalk_width'],join_style=1).union(mapped_foot)
    # Millimetre snapping can push a sidewalk vertex across an oblique road edge.
    # Reapply the authoritative road boundary after snapping to avoid sliver overlap.
    sidewalks=clean(paved.difference(asphalt).difference(buildings.buffer(.15)).difference(water).intersection(aoi)).difference(asphalt)
    ramp_masks=union([c['geom'].buffer(1.8,cap_style=3) for c in crossings])
    curb=asphalt.buffer(config['curb_width']).difference(asphalt).intersection(sidewalks).difference(ramp_masks)
    # Width-filling strip is clipped to the same asphalt used to generate the road mesh.
    zebra=[]; crossing_areas=[]
    for c in crossings:
        for ln in lines(c['geom']):
            if ln.length<1:continue
            corridor=ln.buffer(1.8,cap_style=2).intersection(asphalt)
            if corridor.area<.5:continue
            crossing_areas.append(corridor)
            d=.3
            while d<ln.length:
                q=ln.interpolate(d); dx,dy=tangent(ln,d)
                z=stripe((q.x,q.y),(-dy,dx),3.2,.48).intersection(asphalt)
                if z.area>.02:zebra.append(z)
                d+=.96
    crossing_area=union(crossing_areas)
    clearance=union([j['point'].buffer(j['radius']+1.5) for j in js]).union(crossing_area.buffer(2))
    white=[]; yellow=[]; arrows=[]; stop=[]
    # Merge compatible way fragments for continuous dash spacing (stable source order).
    groups=defaultdict(list)
    for rd in drive:
        props=rd['properties']; key=(props.get('name',''),rd['class'],rd['width'],rd['lanes'],props.get('oneway','no'))
        groups[key].append(rd['geom'])
    for (_,cls,w,n,oneway),gs in groups.items():
        merged=union(gs)
        if merged.geom_type=='MultiLineString':merged=line_merge(merged,directed=True)
        for ln in lines(merged):
            if ln.length<3:continue
            is_oneway=oneway in ('yes','1','-1')
            for i in range(1,n):
                off=(i/n-.5)*w
                center=not is_oneway and abs(off)<.01
                distances=[j*.9 for j in range(int(ln.length/.9))] if center else range(2,int(ln.length),9)
                for d in distances:
                    q=ln.interpolate(d); dx,dy=tangent(ln,d)
                    mark=stripe((q.x-dy*off,q.y+dx*off),(dx,dy),1 if center else 3.8,.13)
                    mark=mark.intersection(asphalt).difference(clearance)
                    if mark.area>.001:(yellow if center else white).append(mark)
            # Thin edge lines emphasize the real carriageway, kept away from junction openings.
            if cls in ('primary','tertiary'):
                for off in (-w/2+.25,w/2-.25):
                    edge=ln.offset_curve(off,join_style=1).buffer(.055).intersection(asphalt).difference(clearance)
                    white.append(edge)
            # Direction arrows set by one-way / lane side, never guessed turn arrows.
            if ln.length>28 and n>=1:
                for d in range(18,int(ln.length)-7,55):
                    dx,dy=tangent(ln,d); q=ln.interpolate(d)
                    for i in range(n):
                        off=((i+.5)/n-.5)*w; direction=-1 if oneway=='-1' or (not is_oneway and off>0) else 1
                        ux,uy=dx*direction,dy*direction; cx=q.x-dy*off; cy=q.y+dx*off
                        pts=[(-.13,-1.5),(.13,-1.5),(.13,.55),(.55,.35),(0,1.5),(-.55,.35),(-.13,.55)]
                        poly=Polygon([(cx-uy*x+ux*y,cy+ux*x+uy*y) for x,y in pts])
                        if asphalt.covers(poly) and not poly.intersects(clearance):arrows.append(poly)
    # Stop bars upstream of mapped crossings, only on inbound lanes.
    for rd in drive:
        if rd['lanes']<1:continue
        for ln in lines(rd['geom']):
            for c in crossings:
                hits=ln.intersection(c['geom'])
                points=[hits] if hits.geom_type=='Point' else [p for p in getattr(hits,'geoms',[]) if p.geom_type=='Point']
                for pt in points:
                    s=ln.project(pt); one=rd['properties'].get('oneway') in ('yes','1','-1')
                    for direction in ([(-1 if rd['properties'].get('oneway')=='-1' else 1)] if one else [1,-1]):
                        d=s-4*direction
                        if not 1<d<ln.length-1:continue
                        q=ln.interpolate(d); dx,dy=tangent(ln,d); width=rd['width']-.5 if one else rd['width']/2-.3
                        off=0 if one else -direction*rd['width']/4
                        stop.append(stripe((q.x-dy*off,q.y+dx*off),(-dy,dx),width,.3).intersection(asphalt))
    return dict(roads=drive,foot=foot,junctions=js,bridges=bridges,excluded=excluded,
        asphalt=asphalt,sidewalks=sidewalks,curb=clean(curb),ramps=sidewalks.intersection(ramp_masks),
        zebra=union(zebra),white=union(white+arrows+stop),yellow=union(yellow),crossings=crossings,
        crossing_area=crossing_area,clearance=clearance,patches=patches.intersection(asphalt))

def block_parcels(net,aoi,water,buildings,config):
    """Actual road-bounded blocks plus illustrative frontage parcels; no cadastral claim."""
    occupied=net['asphalt'].union(net['sidewalks']).union(water)
    free=clean(aoi.difference(occupied))
    building_keepout=buildings.buffer(1)
    frontage_zone=net['sidewalks'].buffer(2.3)
    aoi_edge=aoi.boundary.buffer(.01)
    blocks=[]; parcels=[]; greens=[]
    for i,p in enumerate(sorted(polygons(free),key=lambda p:(round(p.centroid.x),round(p.centroid.y)))):
        if p.area<20:continue
        edge=p.boundary.intersection(aoi_edge).length>1
        block={'id':f'block_{i:03d}','geom':p,'clipped':edge};blocks.append(block)
        # Erode toward the interior to obtain planted setbacks and parcel boundaries.
        inner=p.buffer(-2,join_style=1)
        if inner.is_empty:greens.append(p);continue
        rect=p.minimum_rotated_rectangle; cc=list(rect.exterior.coords)
        a,b=max(zip(cc,cc[1:]),key=lambda ab:Point(ab[0]).distance(Point(ab[1])))
        ux,uy=tangent(LineString([a,b]),0); vx,vy=-uy,ux
        projected=[(x*ux+y*uy,x*vx+y*vy) for x,y in p.exterior.coords]
        u0,u1=min(c[0] for c in projected),max(c[0] for c in projected)
        v0,v1=min(c[1] for c in projected),max(c[1] for c in projected)
        front=config['parcel_frontage']; depth=config['parcel_depth']; n=0
        for iu in range(math.ceil((u1-u0)/front)):
            for iv in range(math.ceil((v1-v0)/depth)):
                aa=u0+iu*front; bb=v0+iv*depth
                cell=Polygon([(u*ux+v*vx,u*uy+v*vy) for u,v in [(aa,bb),(aa+front,bb),(aa+front,bb+depth),(aa,bb+depth)]])
                for part in polygons(cell.intersection(inner)):
                    # Keep generated boundaries away from sourced footprints and require road access.
                    if part.area<config['min_parcel_area'] or part.intersects(building_keepout):continue
                    frontage=part.boundary.intersection(frontage_zone).length
                    if frontage<5:continue
                    parcels.append({'id':f"{block['id']}_lot_{n:03d}",'block':block['id'],'geom':part,'frontage_m':frontage,'status':'illustrative'});n+=1
        greens.append(p.difference(inner))
    return blocks,parcels,union(greens)
