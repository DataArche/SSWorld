"""Data-driven road / block template compiler. All dimensions are metres."""
import collections,hashlib,json,math,os,pickle,random,shutil
from pathlib import Path
from shapely import STRtree,make_valid,segmentize,get_precision,set_precision
from shapely.geometry.base import BaseGeometry
from shapely.geometry import shape,mapping,Polygon,Point,LineString,box
from shapely.geometry.polygon import orient
from .projection import ROOT,load
from .geometry import polygons,lines,union,clean,road_network,block_parcels,tangent,stripe
from .mesh import Mesh,rgb,textures
from .furniture import write_furniture
from .props import build_props,TREES
from . import neighborhood as hood

def solar_azimuth(stamp,lat,lon):
    """Sun azimuth (degrees clockwise from north) for an ISO local time with offset; NOAA approximation."""
    from datetime import datetime,timezone
    t=datetime.fromisoformat(stamp).astimezone(timezone.utc);doy=t.timetuple().tm_yday
    g=2*math.pi/365*(doy-1+(t.hour-12)/24)
    eqt=229.18*(.000075+.001868*math.cos(g)-.032077*math.sin(g)-.014615*math.cos(2*g)-.040849*math.sin(2*g))
    decl=.006918-.399912*math.cos(g)+.070257*math.sin(g)-.006758*math.cos(2*g)+.000907*math.sin(2*g)-.002697*math.cos(3*g)+.00148*math.sin(3*g)
    ha=math.radians((t.hour*60+t.minute+eqt+4*lon)/4-180);phi=math.radians(lat)
    zen=math.acos(math.sin(phi)*math.sin(decl)+math.cos(phi)*math.cos(decl)*math.cos(ha))
    az=math.degrees(math.acos(max(-1,min(1,(math.sin(phi)*math.cos(zen)-math.sin(decl))/(math.cos(phi)*math.sin(zen))))))
    return (az+180)%360 if ha>0 else (540-az)%360

def sight_clear(target,offset,tall):
    """True when the straight line from target+offset (x, y, height) down to target passes over every
    (footprint, height) in `tall`."""
    tree=STRtree([g for g,_ in tall]) if tall else None;ox,oy,oz=offset
    for t in [i/20 for i in range(1,20)]:
        q=Point(target.x+ox*(1-t),target.y+oy*(1-t));z=oz*(1-t)
        if tree is not None and any(tall[i][1]>z and tall[i][0].contains(q) for i in tree.query(q)):return False
    return True

def plane_rect(x,y,w,d,yaw):
    """Footprint of a Plane of width w (local x) and depth d (local y), rotated by yaw about z."""
    c,sn=math.cos(yaw),math.sin(yaw)
    return Polygon([(x+u*c-v*sn,y+u*sn+v*c) for u,v in [(-w/2,-d/2),(w/2,-d/2),(w/2,d/2),(-w/2,d/2)]])

def _freeze(obj):
    """Pickle drops a geometry's precision grid, which changes later overlay results; keep it alongside."""
    if isinstance(obj,BaseGeometry):return ('__geom__',obj,get_precision(obj))
    if isinstance(obj,dict):return {k:_freeze(v) for k,v in obj.items()}
    if isinstance(obj,(list,tuple)):return type(obj)(_freeze(v) for v in obj)
    return obj

def _thaw(obj):
    if isinstance(obj,tuple) and len(obj)==3 and obj[0]=='__geom__':
        return set_precision(obj[1],obj[2]) if obj[2]>0 else obj[1]
    if isinstance(obj,dict):return {k:_thaw(v) for k,v in obj.items()}
    if isinstance(obj,(list,tuple)):return type(obj)(_thaw(v) for v in obj)
    return obj

def build(config):
    for key in ['lane_width','sidewalk_width','curb_width','curb_height','corner_radius','tree_spacing','lamp_spacing','parcel_frontage','parcel_depth','min_parcel_area']:
        if not isinstance(config.get(key),(int,float)) or config[key]<=0:raise ValueError(f'{key} must be positive')
    projected=load(config);out=ROOT/config['output_dir'];assets=out/'assets';assets.mkdir(parents=True,exist_ok=True)
    rng=random.Random(config['seed']); aoi=Polygon(projected['aoi']); margin=aoi.buffer(35)
    data={};repairs=[]
    for kind,fc in projected['layers'].items():
        data[kind]=[]
        for f in fc['features']:
            geom=shape(f['geometry'])
            if not geom.is_valid:repairs.append(f.get('id',f['properties'].get('@id')))
            geom=make_valid(geom).intersection(margin)
            if not geom.is_empty:data[kind].append({**f,'_geom':geom})
    building_geom=union([f['_geom'] for f in data['buildings']]);water=union([f['_geom'] for f in data['water_polygons']]).intersection(aoi)
    # ROAD_TEMPLATE_DEV_CACHE=1 reuses the road network and parcels while iterating on styling only.
    cache=None
    if os.environ.get('ROAD_TEMPLATE_DEV_CACHE'):
        shaping={k:v for k,v in config.items() if k not in ('infill','vegetation','lighting','lamp_asset','tree_scale_range','name','note','site')}
        key=hashlib.sha256((projected['input_digest']+json.dumps(shaping,sort_keys=True)).encode()).hexdigest()[:16]
        cache=ROOT/'.cache/road_template'/f'{key}.pkl'
    if cache and cache.exists():net,blocks,parcels,setbacks=_thaw(pickle.loads(cache.read_bytes()))
    else:
        net=road_network(data['roads'],config,aoi,building_geom,water)
        blocks,parcels,setbacks=block_parcels(net,aoi,water,building_geom,config)
        if cache:cache.parent.mkdir(parents=True,exist_ok=True);cache.write_bytes(pickle.dumps(_freeze((net,blocks,parcels,setbacks))))
    textures(assets,config['seed']);mesh_stats={}
    def save(name,g,z,color,texture=None,walls=None,uvscale=1):
        mesh=Mesh();mesh.surface(g,z,rgb(color),uvscale)
        if walls is not None:mesh.walls(g,walls,z,rgb(color))
        info=mesh.save(assets/(name+'.glb'),assets/texture if texture else None)
        if info:mesh_stats[name]=info
        return info
    # The shared surfaces are the authoritative geometry for all downstream details.
    save('asphalt',net['asphalt'],.08,'ffffff','asphalt.png',uvscale=5)
    save('road_foundation',net['asphalt'],.05,'575958',walls=-.18)
    save('curbs',net['curb'],.08+config['curb_height']+.01,'c6c6b8',walls=.075)
    crossing_keepout=net['crossing_area'].buffer(5)
    tree_keepout=net['clearance'].buffer(2)
    instances={}
    def plant(model,group,x,y,z,rotation=0,scale=1):
        rows=instances.setdefault(model,{}).setdefault(group,{'positions':[],'rotations_z':[],'scales_uniform':[]})
        rows['positions'].append([round(x,3),round(y,3),z]);rows['rotations_z'].append(round(rotation,2));rows['scales_uniform'].append(round(scale,3))
    counts={'street_trees':0}
    lamp_rows=[];lamp_rot=[];pits=[];grates=[]
    occupied_points=[];lamp_points=[]
    for rd in net['roads']:
        if rd['class'].endswith('_link') or rd['class'] in ('motorway','motorway_link','service'):continue
        for ln in lines(rd['geom']):
            for off in (-rd['width']/2-1.65,rd['width']/2+1.65):
                for ol in lines(ln.offset_curve(off,join_style=1)):
                    for d in range(6,int(ol.length)-3,config['tree_spacing']):
                        q=ol.interpolate(d);pit=box(q.x-.65,q.y-.65,q.x+.65,q.y+.65)
                        if not net['sidewalks'].covers(pit) or q.distance(aoi.boundary)<2 or q.distance(building_geom)<4:continue
                        if q.intersects(tree_keepout) or any(q.distance(t)<8 for t in occupied_points):continue
                        occupied_points.append(q);pits.append(pit);counts['street_trees']+=1
                        plant(hood.street_species(rd['id'],rng),'furniture',q.x,q.y,.12,rng.randrange(360),rng.uniform(*config.get('tree_scale_range',[.85,1.1])))
                    for d in range(12,int(ol.length)-2,config['lamp_spacing']):
                        q=ol.interpolate(d);dx,dy=tangent(ol,d)
                        if not net['sidewalks'].covers(q.buffer(.3)) or q.intersects(crossing_keepout):continue
                        if any(q.distance(t)<3 for t in occupied_points) or any(q.distance(t)<18 for t in lamp_points):continue
                        lamp_points.append(q);lamp_rows.append([round(q.x,3),round(q.y,3),.23]);lamp_rot.append(round(math.degrees(math.atan2(-dy,-dx)) if off>0 else math.degrees(math.atan2(dy,dx)),2))
            for ln2 in lines(rd['geom']):
                for d in range(9,int(ln2.length)-2,32):
                    q=ln2.interpolate(d);dx,dy=tangent(ln2,d);off=rd['width']/2-.35
                    g=stripe((q.x-dy*off,q.y+dx*off),(dx,dy),.8,.35)
                    if net['asphalt'].covers(g) and not g.intersects(net['clearance']):grates.append(g)
    pit_union=union(pits)
    sidewalks=net['sidewalks'].difference(pit_union)
    regular=sidewalks.difference(net['ramps']);ramps=sidewalks.intersection(net['ramps'])
    save('sidewalks',regular,.23,'ffffff','paving.png',walls=.06,uvscale=2.4)
    save('ramps',segmentize(ramps,.5),lambda x,y:.085+.145*min(1,Point(x,y).distance(net['asphalt'])/1.6),'ffffff','paving.png',uvscale=2.4)
    save('tree_pits',pit_union,.105,'453f2a',walls=.07)
    save('pit_frames',pit_union.buffer(.075).difference(pit_union),.235,'8b8c79')
    save('drainage',union(grates),.093,'323735')
    # Curb joints, individually spaced by arc length, remain clipped to the curb ribbon.
    joints=[]
    for ln in lines(net['asphalt'].boundary):
        for i in range(int(ln.length/.9)):
            q=ln.interpolate(i*.9);dx,dy=tangent(ln,i*.9)
            joints.append(stripe((q.x,q.y),(-dy,dx),.55,.014).intersection(net['curb']))
    save('curb_joints',union(joints),.251,'818575')
    save('markings_white',net['white'].union(net['zebra']),.098,'f3f0df')
    save('markings_yellow',net['yellow'],.099,'efbb37')
    # Tactile warnings at sourced crossings; dimensions are an explicit design rule.
    tactile=[]
    for c in net['crossings']:
        for ln in lines(c['geom']):
            for pt in [ln.interpolate(0),ln.interpolate(ln.length)]:
                if sidewalks.distance(pt)>.8:continue
                t=pt.buffer(.62,cap_style=3).intersection(sidewalks).difference(net['curb'])
                if t.area>.1:tactile.append(t)
    save('tactile',union(tactile),.238,'dab65f')
    # Retain sourced land use; neutral floors communicate unmapped interiors without fake buildings.
    # The river is a channel cut into the base slab: bed below, WaterMaterial planes at water level.
    channel=clean(water.difference(net['asphalt'].union(net['sidewalks'])))
    save('base',clean(aoi.difference(channel)),-.065,'6d6856',walls=-2)
    save('river_bed',channel.buffer(.5).intersection(aoi),-1.8,'3a3a2b')
    # Unmapped and residential ground reads as lawn; only hard land uses keep a paved/earth floor.
    cover=union([f['_geom'] for f in data['greenery'] if f['properties'].get('data_category')=='vegetation_cover'])
    ground_clear=aoi.difference(net['asphalt'].union(net['sidewalks'])).difference(water).difference(building_geom)
    designed_green=setbacks.intersection(ground_clear)
    landuse=[(f['properties']['landuse'],f['_geom']) for f in data['landuse']]
    hard=union([g for use,g in landuse if use in hood.HARD_USES]).intersection(ground_clear)
    grass=clean(cover.intersection(ground_clear).union(designed_green).union(ground_clear.difference(hard)))
    save('landscape',grass,.005,'ffffff','grass.png',uvscale=24)
    # Grass skirt past the data edge so the district does not float on the atmosphere.
    save('skirt',aoi.buffer(3000,join_style=2).difference(aoi),-.07,'e6ead8','grass.png',uvscale=24,walls=-2)
    land_mesh=Mesh();land_rows=[]
    colors={'residential':'b7b3a2','retail':'b1ada2','industrial':'a8a69d','construction':'a88f6b','brownfield':'9d8d6c'}
    for f in data['landuse']:
        use=f['properties']['landuse']
        if use in ('grass','flowerbed'):continue
        g=f['_geom'].intersection(ground_clear).difference(grass)
        land_mesh.surface(g,-.015,rgb(colors.get(use,'b9b5a8')))
        land_rows.append({'id':f['properties']['@id'],'use':use,'geometry':mapping(g)})
    info=land_mesh.save(assets/'landuse.glb')
    if info:mesh_stats['landuse']=info
    (assets/'water.glb').unlink(missing_ok=True)
    water_planes=[]
    for i,p in enumerate(polygons(channel)):
        if p.area<20:continue
        rect=p.minimum_rotated_rectangle;cc=list(rect.exterior.coords)
        (ax,ay),(bx,by),(qx,qy)=cc[0],cc[1],cc[2];w=math.hypot(bx-ax,by-ay);d=math.hypot(qx-bx,qy-by)
        yaw=math.atan2(by-ay,bx-ax);flow=math.degrees(math.atan2(bx-ax,by-ay) if w>=d else math.atan2(qx-bx,qy-by))%360
        c=rect.centroid;water_planes.append((f'water_{i}',c.x,c.y,w+2,d+2,yaw,flow))
    bank=water.buffer(.65).difference(water).intersection(ground_clear)
    save('river_bank',bank,.12,'8b927f',walls=-.15)
    # Illustrative infill: houses facing their frontage, driveways, hedges, yard and woodland planting.
    props=build_props(assets)
    layout=hood.plan(parcels,net,landuse,building_geom,water,aoi,props,config)
    hs=hood.surfaces(layout,net)
    save('driveways',hs['drives'],.035,'4b4d4f')
    save('garden_paths',hs['paths'],.04,'bcb5a4')
    save('work_yards',hs['aprons'],.03,'a4a39c')
    hedge=Mesh()
    for g,h in [(hs['hedges'],1.25),(hs['front_hedges'],.85)]:hedge.surface(g,h,rgb('3d6a2a'));hedge.walls(g,0,h,rgb('2c4f20'))
    info=hedge.save(assets/'hedges.glb')
    if info:mesh_stats['hedges']=info
    save('fences',hs['fences'],1.0,'dcd7cb',walls=0)
    for h in layout['placed']:
        x,y=h['position'];plant(h['model'],'infill',x,y,0,h['rotation_z'],h['scale'])
    for model,x,y,scale in hood.yard_planting(layout,hs['drives'],rng):plant(model,'infill',x,y,0,rng.randrange(360),scale)
    veg=config.get('vegetation',{});spacing=veg.get('woodland_spacing',11)
    parcel_union=union([p['geom'] for p in parcels])
    wild=ground_clear.difference(parcel_union).difference(net['sidewalks'].buffer(3.5)).difference(net['asphalt'].buffer(5))\
        .difference(building_geom.buffer(4)).difference(water.buffer(2))
    belt=aoi.buffer(veg.get('forest_belt',140),join_style=2).difference(aoi.buffer(6,join_style=2)).difference(net['asphalt'].buffer(10))
    woods=hood.woodland(wild.difference(hard),spacing,config['seed']+11,.55)+hood.woodland(wild.intersection(hard),spacing*1.7,config['seed']+13,.3)\
        +hood.woodland(belt,spacing*.95,config['seed']+17,.7)
    cap=veg.get('max_woodland_trees',12000)
    if len(woods)>cap:woods=[woods[i] for i in sorted(random.Random(config['seed']).sample(range(len(woods)),cap))]
    for model,x,y,scale in woods:plant(model,'furniture',x,y,0,rng.randrange(360),scale)
    counts.update(houses=sum(not h['model'].startswith('workshop') for h in layout['placed']),workshops=sum(h['model'].startswith('workshop') for h in layout['placed']),
                  unbuilt_parcels=layout['skipped'],woodland_trees=len(woods),water_planes=len(water_planes))
    lot_lines=union([p['geom'].boundary.buffer(.065) for p in parcels])
    save('parcel_lines',lot_lines,.02,'d9c48a')
    save('block_lines',union([b['geom'].boundary.buffer(.07) for b in blocks]),.022,'a5b69a')
    # Unknown bridge heights are not silently turned into intersections. Optional diagnostic guides.
    bridge_guides=union([b['geom'].buffer(.25).intersection(aoi) for b in net['bridges']])
    save('bridge_guides',bridge_guides,.3,'d98749')
    building_mesh=Mesh();windows=Mesh();building_rows=[]
    for f in data['buildings']:
        g=f['_geom'].intersection(aoi)
        if g.is_empty:continue
        p=f['properties'];height=float(p.get('height_m',12));uid=p.get('@id');height=max(3,min(height,100))
        building_mesh.surface(g,height,rgb('c4c1b5'));building_mesh.walls(g,0,height,rgb('d2cdbd'))
        # Thin parapet and per-floor glazing remain illustrative; footprints are unchanged.
        rim=g.difference(g.buffer(-.25));building_mesh.surface(rim,height+.35,rgb('ddd7c7'));building_mesh.walls(rim,height,height+.35,rgb('b6b3a9'))
        for poly in polygons(g):
            poly=orient(poly,sign=1)
            for a,b in zip(poly.exterior.coords,list(poly.exterior.coords)[1:]):
                dx,dy=b[0]-a[0],b[1]-a[1];length=math.hypot(dx,dy)
                if length<3:continue
                ux,uy=dx/length,dy/length;nx,ny=uy*.025,-ux*.025
                for d in range(1,int(length)-1,3):
                    aa=(a[0]+ux*d+nx,a[1]+uy*d+ny);bb=(a[0]+ux*(d+1.6)+nx,a[1]+uy*(d+1.6)+ny)
                    for z in range(2,int(height)-1,3):
                        col=rgb('536c70');windows.tri((*aa,z),(*bb,z),(*bb,z+1.35),col);windows.tri((*aa,z),(*bb,z+1.35),(*aa,z+1.35),col)
        building_rows.append({'id':uid,'height':height,'height_source':p.get('height_source'),'geometry':mapping(g)})
    for name,mesh in [('buildings',building_mesh),('facades',windows)]:
        info=mesh.save(assets/(name+'.glb'))
        if info:mesh_stats[name]=info
    # Vegetation and houses are procedural props (props.py); the lamp reuses an existing asset.
    shutil.copyfile(ROOT/config['lamp_asset'],assets/'lamp.glb')
    for stale in ['tree0','tree1','tree2']:(assets/(stale+'.glb')).unlink(missing_ok=True)
    def model(name,extra=''):
        return f'Model {{ id: mesh_{name}; source: "assets/{name}.glb"; {extra} }}' if name in mesh_stats else ''
    def component(name,names,props=''):
        (out/(name+'.ssdl')).write_text('Group {\n id: root\n'+props+'\n'+'\n'.join(model(n) for n in names)+'\n}\n',encoding='utf-8')
    component('RoadSurfaces',['road_foundation','asphalt','sidewalks','ramps','curbs','tree_pits','pit_frames'])
    component('StreetDetails',['markings_white','markings_yellow','curb_joints','drainage','tactile'])
    component('Context',['skirt','base','river_bed','landuse','landscape','river_bank'])
    # Oversized planes are fine: the surrounding ground sits above the water level and hides them.
    # The normal map spans the plane's UV 0..1, so uvScale follows the aspect ratio to keep ripples square.
    water_ssdl=['Group {',' id: root']
    for pid,x,y,w,d,yaw,flow in water_planes:
        water_ssdl+=[f' Plane {{ id: {pid}; width: {w:.2f}; depth: {d:.2f}; position: [{x:.3f}, {y:.3f}, -0.35]; rotation: [0, 0, {math.sin(yaw/2):.6f}, {math.cos(yaw/2):.6f}] }}',
                     f' WaterMaterial {{ target: {pid}; baseColor: "#1b5a80"; deepColor: "#0a2c48"; depthFadeDistance: 1.0; opacity: 0.93; roughness: 0.02; specular: 1; '
                     f'waveIntensity: 0.18; flowDirection: {flow:.1f}; flowSpeed: 0.3; uvScale: [{2*max(1,w/d):.3f}, {2*max(1,d/w):.3f}] }}']
    (out/'Water.ssdl').write_text('\n'.join(water_ssdl+['}',''])  ,encoding='utf-8')
    component('Neighborhood',['driveways','garden_paths','work_yards','hedges','fences'])
    component('Buildings',['buildings','facades'])
    component('Blocks',['parcel_lines','block_lines'])
    component('Constraints',['bridge_guides'])
    instances['lamp']={'furniture':{'positions':lamp_rows,'rotations_z':lamp_rot}}
    write_furniture(out,instances)
    (out/'host_interfaces.json').write_text(json.dumps({'Furniture':{'methods':{'sync':{'args':[{'name':'enabled','type':'bool'},{'name':'infill','type':'bool'}]}}}}),encoding='utf-8')
    (out/'logic.mjs').write_text('''export async function createHostInterfaces(api) {
 const groups = await (await fetch(new URL('./furniture-rows.json', import.meta.url))).json();
 const previous = {};
 const apply = (group, on) => {
   if (previous[group] === on) return;
   for (const [id, batch] of Object.entries(groups[group] || {})) api.instances.set(id, on ? batch : {positions: []});
   previous[group] = on;
 };
 return {Furniture: {sync({enabled, infill}) { apply('furniture', enabled); apply('infill', infill); }}};
}
''',encoding='utf-8')
    # Camera targets are projected with the engine, then snapped to the nearest graph junction whose
    # sight line from the preset camera offset is not blocked by a sourced building.
    tall=[(f['_geom'],f['properties'].get('height_m',16)) for f in data['buildings']]
    def closest_view(key,offset):
        q=Point(projected['views'][key]); candidates=sorted((j['point'] for j in net['junctions'] if aoi.buffer(-20).contains(j['point'])),key=q.distance)
        return next((p for p in candidates if sight_clear(p,offset,tall)),candidates[0] if candidates else q)
    DETAIL,CROSS=(33,-45,39),(45,-50,46)
    target=closest_view('detail_geo',DETAIL);cross=closest_view('crossing_geo',CROSS);cx,cy=aoi.centroid.coords[0]
    span=max(aoi.bounds[2]-aoi.bounds[0],aoi.bounds[3]-aoi.bounds[1])
    # Default view: the junction and heading that put the most infill houses in a low oblique frame.
    # The sun sits ahead-right of the camera (as in the reference): lit roofs, long shadows, no backlit haze.
    light={'date_time':'2026-11-05T16:15:00+08:00','sun_intensity':1.35,'white_temperature':5600,'fog_density':.012,**config.get('lighting',{})}
    sun_az=solar_azimuth(light['date_time'],config['anchor'][1],config['anchor'][0])
    homes=[h['position'] for h in layout['placed'] if not h['model'].startswith('workshop')]
    hx=[x for x,_ in homes];hy=[y for _,y in homes];best=(-1,None)
    for j in net['junctions']:
        if not aoi.buffer(-320).contains(j['point']):continue
        for k in range(-3,4):
            a=math.radians(sun_az-100+k*12);d=(math.sin(a),math.cos(a));c=(j['point'].x-d[0]*160,j['point'].y-d[1]*160)
            score=0
            for x,y in zip(hx,hy):
                vx,vy=x-c[0],y-c[1];along=vx*d[0]+vy*d[1]
                if 90<along<420 and abs(vx*d[1]-vy*d[0])<along*.55:score+=1
            if score>best[0]:best=(score,(j['point'],d))
    if best[1]:
        jp,d=best[1];street=((jp.x-d[0]*150,jp.y-d[1]*150,100),(jp.x+d[0]*45,jp.y+d[1]*45,0))
    else:street=((target.x+80,target.y-110,95),(target.x,target.y,0))
    # Riverside view: the channel point closest to the district centre, seen with the sun to the right.
    if water_planes:
        from shapely.ops import nearest_points
        rp=nearest_points(channel,Point(cx,cy))[0];a=math.radians(sun_az-100);d=(math.sin(a),math.cos(a))
        riverside=((rp.x-d[0]*120,rp.y-d[1]*120,62),(rp.x+d[0]*20,rp.y+d[1]*20,0))
    else:riverside=street
    cameras=[street,((cx+span*.62*1.2,cy-span*.82*1.2,span*.9*1.2),(cx,cy,0)),((target.x+DETAIL[0],target.y+DETAIL[1],DETAIL[2]),(target.x,target.y,0)),
             ((cross.x+CROSS[0],cross.y+CROSS[1],CROSS[2]),(cross.x,cross.y,0)),((cx,cy-.1,span*1.5),(cx,cy,0)),riverside]
    poses=[]
    for pos,look in cameras:
        dx,dy,dz=[b-a for a,b in zip(pos,look)]
        poses.append({'position':pos,'heading':math.degrees(math.atan2(dx,dy))%360,'pitch':math.degrees(math.atan2(dz,math.hypot(dx,dy)))})
    hour=int(light['date_time'][11:13])+int(light['date_time'][14:16])/60
    expr=lambda vs:' : '.join(f'main.viewMode === {i} ? {round(v,4)}' for i,v in enumerate(vs[:-1]))+' : '+str(round(vs[-1],4))
    scene=f'''Scene {{
 id: main
 property real viewMode: 0
 property bool showDetails: true
 property bool showFurniture: true
 property bool showInfill: true
 property bool showLots: false
 property bool showBuildings: true
 property bool showConstraints: false
 property real timeOfDay: {round(hour,4)}
 property string sceneDateTime: "{light['date_time']}"
 SkyAtmosphere {{ id: sky }}
 Environment {{ id: clock; dateTime: main.sceneDateTime; latitude: 22.7; longitude: 114.043; timeScale: 0 }}
 DirectionalLight {{ id: sun; atmosphereSunLight: true; castShadows: true; intensity: {light['sun_intensity']} }}
 SkyLight {{ id: ambient; intensity: 1 }}
 ExponentialHeightFog {{ id: haze; fogDensity: {light['fog_density']}; fogHeightFalloff: 0.2; fogInscatteringColor: "#b8b3a4"; directionalInscatteringColor: "#e9c690"; directionalInscatteringExponent: 12 }}
 PostProcessVolume {{ id: optics; unbound: true; priority: 10; settings.autoExposureMethod: "Manual"; settings.autoExposureBias: 0.5; settings.lensFlareThreshold: 128; settings.temperature: {light['white_temperature']}; settings.vignetteIntensity: 0.25 }}
 Context {{ id: context }}
 Water {{ id: river }}
 RoadSurfaces {{ id: roads }}
 StreetDetails {{ id: details; visible: main.showDetails }}
 StreetFurniture {{ id: furniture; visible: main.showFurniture }}
 Neighborhood {{ id: neighborhood; visible: main.showInfill }}
 Buildings {{ id: buildings; visible: main.showBuildings }}
 Blocks {{ id: blocks; visible: main.showLots }}
 Constraints {{ id: constraints; visible: main.showConstraints }}
 Timer {{ id: furnitureSync; interval: 200; repeat: true; running: true; onTriggered: {{ Furniture.sync(enabled: main.showFurniture, infill: main.showInfill) }} }}
 CameraView {{ id: view;
'''
    scene+='  position: ['+', '.join(expr([p['position'][i] for p in poses]) for i in range(3))+'];\n'
    scene+='  heading: '+expr([p['heading'] for p in poses])+';\n  pitch: '+expr([p['pitch'] for p in poses])+';\n  fov: 58; duration: 750\n }\n Camera { id: camera; initialView: view }\n}\n'
    scene=scene.replace('latitude: 22.7; longitude: 114.043;',f"latitude: {config['anchor'][1]}; longitude: {config['anchor'][0]};")
    (out/'scene.ssdl').write_text(scene,encoding='utf-8')
    parcel_by_id={p['id']:p['geom'] for p in parcels}
    checks={
        'road_sidewalk_overlap_m2':net['asphalt'].intersection(net['sidewalks']).area,
        'road_building_overlap_m2':net['asphalt'].intersection(building_geom).area,
        'markings_outside_road_m2':net['white'].union(net['yellow']).union(net['zebra']).difference(net['asphalt']).area,
        'invalid_output_surfaces':sum(not g.is_valid for g in [net['asphalt'],net['sidewalks'],net['curb'],grass,channel]),
        'water_uncovered_m2':union([p for p in polygons(channel) if p.area>=20]).difference(union([plane_rect(x,y,w,d,yaw) for _,x,y,w,d,yaw,_ in water_planes])).area,
        'parcel_road_overlap_m2':union([p['geom'] for p in parcels]).intersection(net['asphalt'].union(net['sidewalks'])).area,
        'parcel_building_overlap_m2':union([p['geom'] for p in parcels]).intersection(building_geom).area,
        'parcels_without_frontage':sum(p['frontage_m']<5 for p in parcels),
        'infill_road_overlap_m2':union([h['footprint'] for h in layout['placed']]).intersection(net['asphalt'].union(net['sidewalks'])).area,
        'infill_building_overlap_m2':union([h['footprint'] for h in layout['placed']]).intersection(building_geom).area,
        'infill_outside_parcel_m2':sum(h['footprint'].difference(parcel_by_id[h['parcel']]).area for h in layout['placed'])}
    if any(v>1e-5 for v in checks.values()):raise ValueError(f'Geometry acceptance failed: {checks}')
    report={'schema':'RoadTemplateReport/1','config':config,'projection':projected['provenance'],
        'counts':{'roads':len(net['roads']),'mapped_footways':len(net['foot']),'junction_nodes':len(net['junctions']),
                  'mapped_crossings':sum(c['source']=='osm_crossing' for c in net['crossings']),
                  'inferred_crossings':sum(c['source']!='osm_crossing' for c in net['crossings']),'blocks':len(blocks),'illustrative_parcels':len(parcels),
                  'lamps':len(lamp_rows),'buildings':len(building_rows),'unresolved_bridges':len(net['bridges']),**counts,
                  'instances':{m:{g:len(r['positions']) for g,r in gs.items()} for m,gs in instances.items()}},
        'checks':checks,'repairs':repairs,'excluded_roads':dict(collections.Counter(e['reason'] for e in net['excluded'])),'meshes':mesh_stats,'cameras':poses,
        'limitations':['Planar reference, no DEM.','Bridge guides only, not surveyed bridge decks; enable constraints layer.',
                       'Road widths and curb/sidewalk design are inferred unless tagged or overridden.',
                       'Generated parcels are illustrative frontage cells, not cadastral boundaries.',
                       'Trees and lamps are design placements; buildings are sourced footprints with inferred heights.',
                       'Houses, workshops, driveways, hedges, yard planting and woodland are illustrative infill on generated parcels and unmapped ground, not surveyed buildings or vegetation; hide them with the infill layer.']}
    entities={'roads':[{k:v for k,v in r.items() if k!='geom'}|{'geometry':mapping(r['geom'])} for r in net['roads']],
              'blocks':[{k:v for k,v in b.items() if k!='geom'}|{'geometry':mapping(b['geom'])} for b in blocks],
              'parcels':[{k:v for k,v in p.items() if k!='geom'}|{'geometry':mapping(p['geom'])} for p in parcels],
              'buildings':building_rows,'landuse':land_rows,
              'infill':[{'parcel':h['parcel'],'model':h['model'],'rotation_z':round(h['rotation_z'],2),'status':'illustrative','geometry':mapping(h['footprint'])} for h in layout['placed']],
              'crossings':[{k:v for k,v in c.items() if k!='geom'}|{'geometry':mapping(c['geom'])} for c in net['crossings']],
              'surfaces':{k:mapping(net[k]) for k in ['asphalt','sidewalks','curb','ramps','zebra','white','yellow']}}
    for name,doc in [('report.json',report),('entities.json',entities),('config.snapshot.json',config)]:
        (out/name).write_text(json.dumps(doc,ensure_ascii=False,indent=2),encoding='utf-8')
    # Plan generated from exactly the same polygons as the rendered surfaces, useful for coverage QA.
    west,south,east,north=aoi.bounds;svg=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{west} {-north} {east-west} {north-south}"><rect x="{west}" y="{-north}" width="{east-west}" height="{north-south}" fill="#aaa995"/><g transform="scale(1,-1)">']
    for g,color in [(water,'#487d86'),(grass,'#769260'),(net['sidewalks'],'#d4cfc0'),(net['asphalt'],'#535757'),(net['white'].union(net['zebra']),'#f5eedb'),(net['yellow'],'#efbd49'),(building_geom.intersection(aoi),'#e0d8c3')]:
        for p in polygons(g):svg.append(p.svg(fill_color=color,opacity=1).replace('stroke="#555555"','stroke="none"'))
    for p in parcels:svg.append(p['geom'].svg(fill_color='none',opacity=.6).replace('stroke="#555555"','stroke="#d3b363"').replace('stroke-width="2.0"','stroke-width="0.35"'))
    for h in layout['placed']:svg.append(h['footprint'].svg(fill_color='#c9b79a',opacity=1).replace('stroke="#555555"','stroke="none"'))
    for model,groups in instances.items():
        if model in TREES and not model.startswith('shrub'):
            fill={'conifer':'#2c4a2e','tree_green':'#4f7a2a','birch':'#d8b640','tree_orange':'#c8641c'}.get(model,'#d4a022')
            for rows in groups.values():svg.extend(f'<circle cx="{x}" cy="{y}" r="2.5" fill="{fill}"/>' for x,y,_ in rows['positions'])
    svg.append('</g></svg>');(out/'plan.svg').write_text(''.join(svg),encoding='utf-8')
    return {'output':str(out),'counts':report['counts'],'checks':checks,'triangles':sum(m['triangles'] for m in mesh_stats.values())}
