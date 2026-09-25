"""Stage 1 of the template: download the six OSM source layers for a config's bbox.

Writes `{input_dir}/{source_prefix}{layer}.geojson` in the shape the generator reads, plus the raw
Overpass response and a `{source_prefix}source.json` provenance record (query, OSM timestamp, sha256).
OSM is a mapped current-use snapshot: no cadastral, statutory or survey-accuracy claim.
"""
import datetime,hashlib,json,sys,time,urllib.error,urllib.parse,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'.deps/guanlan-gis'))
from shapely import make_valid
from shapely.geometry import LineString,Point,Polygon,box,mapping
from shapely.ops import polygonize,unary_union

LAYERS=('roads','buildings','landuse','greenery','water_lines','water_polygons')
COVER_LANDUSE=('grass','forest','meadow','orchard','plant_nursery','flowerbed')
COVER_NATURAL=('wood','scrub','grassland','heath','wetland')
COVER_LANDCOVER=('grass','trees','scrub','flowerbed')
WATERWAYS=('river','stream','canal','drain','ditch','weir')
# Type defaults when OSM has neither height nor building:levels; recorded as inferred per feature.
HEIGHT_DEFAULTS={'house':9.6,'residential':19.2,'apartments':32.0,'commercial':22.0,'office':28.0,
                 'government':24.0,'industrial':12.0,'warehouse':10.0,'school':16.0}

def query(bbox):
    w,s,e,n=bbox
    return f'''[out:json][timeout:120][bbox:{s},{w},{n},{e}];
(
 way[highway];
 way[building];relation[building][type=multipolygon];
 way[landuse];relation[landuse][type=multipolygon];
 nwr[natural~"^(wood|scrub|grassland|heath|wetland|tree|tree_row|water)$"];
 nwr[leisure~"^(park|garden|nature_reserve)$"];
 nwr[landcover~"^(grass|trees|scrub|flowerbed)$"];
 way[waterway];relation[waterway=riverbank];
);out meta geom;'''

# Public instances are often busy (429/504); try each in turn, then back off and retry the list.
ENDPOINTS=['https://overpass-api.de/api/interpreter','https://overpass.private.coffee/api/interpreter','https://overpass.kumi.systems/api/interpreter']

def download(endpoints,q,rounds=3):
    errors=[]
    for attempt in range(rounds):
        for endpoint in endpoints:
            try:
                req=urllib.request.Request(endpoint,data=urllib.parse.urlencode({'data':q}).encode(),headers={'User-Agent':'SSWorldRoadTemplate/1.0'})
                with urllib.request.urlopen(req,timeout=180) as r:payload=r.read()
                doc=json.loads(payload)
                if doc.get('remark') and 'error' in doc['remark'].lower():raise RuntimeError(doc['remark'])
                print('Overpass:',endpoint,len(payload),'bytes',file=sys.stderr);return endpoint,payload
            except (urllib.error.URLError,TimeoutError,RuntimeError,ValueError) as e:
                errors.append(f'{endpoint}: {e}');print('Overpass failed:',errors[-1],file=sys.stderr)
        time.sleep(15*(attempt+1))
    raise RuntimeError('All Overpass endpoints failed: '+'; '.join(errors))

def _num(v):
    try:return float(str(v).split(';')[0].strip().lower().replace('m',''))
    except (TypeError,ValueError):return None

def building_height(tags):
    h=_num(tags.get('height'))
    if h and h>0:return round(h,2),'osm_height'
    lv=_num(tags.get('building:levels'))
    if lv and lv>0:return round(lv*3.2,2),'osm_levels_x_3.2m'
    return HEIGHT_DEFAULTS.get(str(tags.get('building','yes')),16.0),'inferred_building_type'

def _rings(members):
    segs=[LineString([(p['lon'],p['lat']) for p in m['geometry']]) for m in members if len(m.get('geometry',[]))>=2]
    return list(polygonize(unary_union(segs))) if segs else []

def element_geometry(e):
    tags=e.get('tags',{})
    if e['type']=='node':return Point(e['lon'],e['lat'])
    if e['type']=='way':
        c=[(p['lon'],p['lat']) for p in e.get('geometry',[])]
        if len(c)>=4 and c[0]==c[-1] and tags.get('area')!='no' and 'highway' not in tags and 'waterway' not in tags:return Polygon(c)
        return LineString(c) if len(c)>=2 else None
    if e['type']=='relation' and tags.get('type')=='multipolygon':
        outer=_rings([m for m in e['members'] if m.get('role','') in ('','outer')])
        inner=_rings([m for m in e['members'] if m.get('role')=='inner'])
        return unary_union(outer).difference(unary_union(inner)) if outer else None
    return None

def layers_of(tags,geom):
    """Which template layers an element feeds; one element may feed several (e.g. a reservoir)."""
    area=geom.geom_type in ('Polygon','MultiPolygon');line=geom.geom_type in ('LineString','MultiLineString');out=[]
    if tags.get('highway') and line:out.append('roads')
    if tags.get('building') and area:out.append('buildings')
    if tags.get('landuse') and area:out.append('landuse')
    if (tags.get('natural')=='water' or tags.get('waterway')=='riverbank' or tags.get('landuse') in ('reservoir','basin')) and area:out.append('water_polygons')
    if tags.get('waterway') in WATERWAYS and line:out.append('water_lines')
    if (tags.get('landuse') in COVER_LANDUSE or tags.get('natural') in COVER_NATURAL+('tree','tree_row')
            or tags.get('leisure') in ('park','garden','nature_reserve') or tags.get('landcover') in COVER_LANDCOVER):out.append('greenery')
    return out

def greenery_props(tags,geom):
    cover=tags.get('landuse') in COVER_LANDUSE or tags.get('natural') in COVER_NATURAL or tags.get('landcover') in COVER_LANDCOVER
    category='vegetation_cover' if cover else 'park_or_garden_boundary'
    if geom.geom_type not in ('Polygon','MultiPolygon'):
        category=('park_poi' if tags.get('leisure')=='park' else 'tree_point') if geom.geom_type=='Point' else 'vegetation_line'
    return {'data_category':category,'boundary_status':'osm_mapped_not_survey_verified','is_statutory_green_line':False}

def convert(doc,bbox):
    aoi=box(*bbox);out={k:[] for k in LAYERS};rejected=[]
    for e in doc['elements']:
        tags=e.get('tags',{});uid=f"{e['type']}/{e['id']}"
        if not tags:continue
        geom=element_geometry(e)
        if geom is None or geom.is_empty:
            if layers_of(tags,Point(0,0)) or tags.get('building') or tags.get('landuse'):rejected.append({'id':uid,'reason':'unsupported or incomplete geometry'})
            continue
        if not geom.is_valid:geom=make_valid(geom)
        for layer in layers_of(tags,geom):
            clipped=geom.intersection(aoi)
            if layer in ('roads','water_lines'):clipped=unary_union([g for g in getattr(clipped,'geoms',[clipped]) if g.geom_type in ('LineString','MultiLineString')])
            elif layer!='greenery':clipped=unary_union([g for g in getattr(clipped,'geoms',[clipped]) if g.geom_type in ('Polygon','MultiPolygon')])
            if clipped.is_empty:continue
            props={'@id':uid,**tags}
            if layer=='buildings':props['height_m'],props['height_source']=building_height(tags)
            if layer=='greenery':props|={**greenery_props(tags,geom),'source':'OpenStreetMap','source_url':'https://www.openstreetmap.org/'+uid,
                                         'osm_version':e.get('version'),'osm_timestamp':e.get('timestamp')}
            out[layer].append({'type':'Feature','id':uid,'properties':props,'geometry':mapping(clipped)})
    return out,rejected

def main():
    args=sys.argv[1:]
    config_path=args[args.index('--config')+1] if '--config' in args else 'tools/road_template/configs/guanlan.json'
    endpoints=[args[args.index('--endpoint')+1]] if '--endpoint' in args else ENDPOINTS
    config=json.loads((ROOT/config_path).read_text(encoding='utf-8'))
    target=ROOT/config['input_dir'];prefix=config.get('source_prefix','');bbox=config['bbox']
    target.mkdir(parents=True,exist_ok=True);raw=target/f'{prefix}osm_raw.json';q=query(bbox)
    if '--offline' not in args:
        endpoint,payload=download(endpoints,q);raw.write_bytes(payload)
    else:endpoint=json.loads((target/f'{prefix}source.json').read_text(encoding='utf-8'))['endpoint']
    doc=json.loads(raw.read_bytes())
    layers,rejected=convert(doc,bbox)
    for k,features in layers.items():
        fc={'type':'FeatureCollection','name':prefix+k,'bbox':list(bbox),'features':features}
        (target/f'{prefix}{k}.geojson').write_text(json.dumps(fc,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    heights=[f['properties']['height_source'] for f in layers['buildings']]
    source={'schema':'RoadTemplateSource/1','endpoint':endpoint,'query':q,'bbox_wgs84':bbox,
            'retrieved_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'osm_base_timestamp':doc.get('osm3s',{}).get('timestamp_osm_base'),'raw_sha256':hashlib.sha256(raw.read_bytes()).hexdigest(),
            'counts':{k:len(v) for k,v in layers.items()},'building_height_inferred':sum(h.startswith('inferred') for h in heights),
            'rejected':rejected,'license':'© OpenStreetMap contributors, ODbL https://www.openstreetmap.org/copyright',
            'limitations':['Road features are centerlines, not a validated lane graph.','Landuse polygons are not cadastral parcels.',
                           'Missing building heights use type-based preview defaults.','No DEM: the template builds a planar design surface.']}
    (target/f'{prefix}source.json').write_text(json.dumps(source,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:source[k] for k in ('osm_base_timestamp','counts','building_height_inferred')},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
