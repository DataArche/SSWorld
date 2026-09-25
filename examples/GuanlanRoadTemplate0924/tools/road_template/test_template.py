"""Behavioural regression tests for road generation, plus real-source geometry checks."""
import sys,json,math,unittest,hashlib,tempfile,struct
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'.deps/guanlan-gis'));sys.path.insert(0,str(ROOT/'tools'))
from shapely.geometry import LineString,box,Polygon,Point,shape
from road_template.geometry import junctions,road_network,block_parcels,EMPTY,clean
from road_template.mesh import Mesh,rgb
from road_template.projection import load
from road_template.furniture import triangle_count,write_furniture,batch_model,regroup
from road_template.props import build_props,HOUSES,WORKSHOPS,DOOR_X,kind
from road_template import neighborhood as hood
from road_template.generator import solar_azimuth,plane_rect,sight_clear
from road_template.fetch_osm import convert

CONFIG=json.loads((ROOT/'tools/road_template/configs/guanlan.json').read_text(encoding='utf-8'))
def feature(uid,coords,**tags):return {'id':uid,'properties':{'highway':'residential',**tags},'_geom':LineString(coords)}

class RoadTests(unittest.TestCase):
    def test_furniture_triangle_quota_and_stable_repartition(self):
        out=ROOT/CONFIG['output_dir'];groups=json.loads((out/'furniture-rows.json').read_text(encoding='utf-8'))
        self.assertEqual(set(groups),{'furniture','infill'})
        report=json.loads((out/'report.json').read_text(encoding='utf-8'));total=0
        for batches in groups.values():
            for name,batch in batches.items():
                count=len(batch['positions']);total+=count
                self.assertLessEqual(count,512)
                self.assertLessEqual(count*triangle_count(out/'assets'/(batch_model(name)+'.glb')),1_000_000)
                for key in ('rotations_z','scales_uniform'):
                    if key in batch:self.assertEqual(len(batch[key]),count)
        self.assertEqual(total,sum(n for g in report['counts']['instances'].values() for n in g.values()))
        c=report['counts'];self.assertEqual(sum(len(b['positions']) for n,b in groups['infill'].items() if batch_model(n) in {**HOUSES,**WORKSHOPS}),c['houses']+c['workshops'])
        # Repartitioning the output itself must preserve every transform and batch.
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as t,patch('road_template.furniture.triangle_count',side_effect=lambda p:triangle_count(out/'assets'/p.name)):
            dest=Path(t);write_furniture(dest,regroup(groups))
            self.assertEqual(json.loads((dest/'furniture-rows.json').read_text(encoding='utf-8')),groups)
    def test_props_are_grounded_and_face_minus_y(self):
        with tempfile.TemporaryDirectory() as t:
            stats=build_props(Path(t))
        for name,info in stats.items():
            self.assertLessEqual(info['triangles'],1200,name)
        for name in {**HOUSES,**WORKSHOPS}:
            x0,y0,x1,y1=stats[name]['bbox']
            # Centred across the frontage, door side (porch, steps) toward -Y.
            self.assertAlmostEqual(x0,-x1,delta=.6,msg=name);self.assertLess(y0,-abs(y1)+.01,name)
            self.assertTrue(x0<DOOR_X[kind(name)]<x1,name)
    def test_infill_faces_frontage_and_stays_inside_parcel(self):
        # One straight street along y=0, sidewalk on its north side, a 22 x 40 m parcel behind it.
        net={'sidewalks':box(-40,4,40,6.6),'asphalt':box(-40,-4,40,4)}
        # Real parcels are the block eroded by 2 m, i.e. 2 m behind the sidewalk.
        parcel=box(-11,8.6,11,48.6);props={}
        with tempfile.TemporaryDirectory() as t:props=build_props(Path(t))
        cfg={**CONFIG,'infill':{'build_share':1}}
        layout=hood.plan([{'id':'p','geom':parcel}],net,[],EMPTY,EMPTY,box(-50,-10,50,60),props,cfg)
        self.assertEqual(len(layout['placed']),1);h=layout['placed'][0]
        self.assertTrue(parcel.buffer(1e-6).contains(h['footprint']))
        # Local -Y (the door side) must point at the street: rotation maps (0,-1) to (0,-1) here.
        a=math.radians(h['rotation_z']);self.assertAlmostEqual(math.sin(a),0,places=6);self.assertAlmostEqual(-math.cos(a),-1,places=6)
        s=hood.surfaces(layout,net)
        self.assertTrue(s['drives'].intersects(box(-11,6.6,11,8.6)),'driveway must reach the sidewalk')
        self.assertEqual(s['drives'].intersection(net['sidewalks']).area,0)
        self.assertEqual(s['hedges'].intersection(h['footprint']).area,0)
    def test_solar_azimuth_and_water_plane_footprint(self):
        self.assertAlmostEqual(solar_azimuth('2026-11-05T16:15:00+08:00',22.7,114.043),243.7,delta=1)
        self.assertLess(solar_azimuth('2026-11-05T08:00:00+08:00',22.7,114.043),180)
        r=plane_rect(10,5,40,10,math.radians(90))
        self.assertAlmostEqual(r.area,400);self.assertTrue(r.contains(Point(10,24)))
    def test_generated_water_uses_water_material(self):
        out=ROOT/CONFIG['output_dir'];ssdl=(out/'Water.ssdl').read_text(encoding='utf-8')
        self.assertIn('WaterMaterial',ssdl);self.assertIn('Plane',ssdl)
        import re
        for w,d,u,v in re.findall(r'width: ([\d.]+); depth: ([\d.]+).*?\n.*?uvScale: \[([\d.]+), ([\d.]+)\]',ssdl):
            # Ripples stay square on a long river plane: uv tiling follows the plane's aspect ratio.
            self.assertAlmostEqual(float(u)/float(v),float(w)/float(d),delta=.01*float(w)/float(d))
        self.assertFalse((out/'assets/water.glb').exists())
        report=json.loads((out/'report.json').read_text(encoding='utf-8'));self.assertLess(report['checks']['water_uncovered_m2'],1e-5)
    def test_camera_sight_line_avoids_tall_buildings(self):
        target=Point(0,0);offset=(33,-45,39);block=box(14,-22,20,-16)  # footprint halfway along the sight line
        self.assertFalse(sight_clear(target,offset,[(block,60)]))
        self.assertTrue(sight_clear(target,offset,[(block,12)]))  # line is ~19.5 m high there
        self.assertTrue(sight_clear(target,offset,[(box(-30,10,-20,20),200)]))
        self.assertTrue(sight_clear(target,offset,[]))

    def test_osm_elements_convert_to_template_layers(self):
        way=lambda i,tags,pts:{'type':'way','id':i,'tags':tags,'geometry':[{'lon':x,'lat':y} for x,y in pts]}
        ring=lambda x0,y0,x1,y1:[(x0,y0),(x1,y0),(x1,y1),(x0,y1),(x0,y0)]
        doc={'elements':[
            way(1,{'highway':'residential'},[(-1,.5),(.5,.5)]),                      # crosses the west edge
            way(2,{'highway':'service','junction':'roundabout'},ring(.2,.2,.3,.3)),  # closed road stays a line
            way(3,{'building':'house','building:levels':'2'},ring(.1,.1,.2,.2)),
            way(4,{'building':'yes'},ring(.6,.6,.7,.7)),
            way(5,{'landuse':'reservoir'},ring(.4,.4,.5,.5)),
            way(6,{'waterway':'river'},[(.0,.9),(.9,.9)]),
            way(7,{'leisure':'park'},ring(.7,.1,.9,.3)),
            way(8,{'highway':'primary'},[(2,2),(3,3)]),                                # outside the bbox
            {'type':'relation','id':9,'tags':{'type':'multipolygon','natural':'water'},'members':[
                {'role':'outer','geometry':[{'lon':x,'lat':y} for x,y in [(.0,.0),(.4,.0),(.4,.05)]]},
                {'role':'outer','geometry':[{'lon':x,'lat':y} for x,y in [(.4,.05),(.0,.05),(.0,.0)]]}]},
            way(10,{},ring(.0,.0,.1,.1))]}                                              # untagged member
        layers,_=convert(doc,[0,0,1,1]);ids={k:[f['id'] for f in v] for k,v in layers.items()}
        self.assertEqual(ids['roads'],['way/1','way/2'])
        self.assertAlmostEqual(shape(layers['roads'][0]['geometry']).length,.5)
        self.assertEqual(layers['roads'][1]['geometry']['type'],'LineString')
        self.assertEqual([(f['properties']['height_m'],f['properties']['height_source']) for f in layers['buildings']],
                         [(6.4,'osm_levels_x_3.2m'),(16.0,'inferred_building_type')])
        self.assertEqual(ids['landuse'],['way/5']);self.assertEqual(ids['water_polygons'],['way/5','relation/9'])
        self.assertAlmostEqual(shape(layers['water_polygons'][1]['geometry']).area,.02)
        self.assertEqual(ids['water_lines'],['way/6'])
        self.assertEqual([(f['id'],f['properties']['data_category']) for f in layers['greenery']],[('way/7','park_or_garden_boundary')])

    def test_unsplit_through_way_t_junction(self):
        roads=[{'geom':LineString([(-25,0),(0,0),(25,0)]),'width':6},{'geom':LineString([(0,0),(0,25)]),'width':6}]
        j=junctions(roads);self.assertEqual(len(j),1);self.assertEqual(j[0]['degree'],3)
    def test_bridge_does_not_create_ground_intersection(self):
        fs=[feature('ground',[(-25,0),(0,0),(25,0)]),feature('bridge',[(0,-25),(0,0),(0,25)],bridge='yes',layer='1')]
        n=road_network(fs,{**CONFIG,'infer_local_crossings':False},box(-30,-30,30,30),EMPTY,EMPTY)
        self.assertEqual(len(n['junctions']),0);self.assertEqual(len(n['bridges']),1)
        self.assertFalse(n['asphalt'].contains(shape({'type':'Point','coordinates':[0,20]})))
    def test_unmarked_crossing_is_not_painted(self):
        fs=[feature('r',[(-30,0),(30,0)]),feature('c',[(0,-8),(0,8)],highway='footway',footway='crossing',**{'crossing:markings':'no'})]
        n=road_network(fs,CONFIG,box(-35,-15,35,15),EMPTY,EMPTY)
        self.assertTrue(n['zebra'].is_empty)
    def test_parallel_carriageways_keep_median(self):
        fs=[feature('a',[(-40,-6),(40,-6)],highway='primary',oneway='yes'),feature('b',[(40,6),(-40,6)],highway='primary',oneway='yes')]
        n=road_network(fs,CONFIG,box(-45,-15,45,15),EMPTY,EMPTY)
        self.assertTrue(n['asphalt'].intersection(box(-30,-1,30,1)).is_empty)
    def test_enclosed_block_and_open_side_both_have_corner_arcs(self):
        fs=[feature('block',[(0,0),(50,0),(50,50),(0,50),(0,0)]),
            feature('branch',[(-30,0),(0,0)])]
        cfg={**CONFIG,'infer_local_crossings':False,'overrides':{'block':{'width':6},'branch':{'width':6}}}
        n=road_network(fs,cfg,box(-40,-20,65,65),EMPTY,EMPTY)
        for pt in [Point(-4,4),Point(4,4),Point(46,4),Point(46,46),Point(4,46)]:
            self.assertTrue(n['asphalt'].covers(pt),f'Unrounded corner at {pt}')
        self.assertFalse(n['asphalt'].covers(Point(25,25)))
    def test_closed_narrow_median_survives_rounding(self):
        fs=[feature('ring',[(-40,-4),(40,-4),(40,4),(-40,4),(-40,-4)]),
            feature('branch',[(40,4),(60,4)])]
        cfg={**CONFIG,'infer_local_crossings':False,'overrides':{'ring':{'width':6},'branch':{'width':6}}}
        n=road_network(fs,cfg,box(-50,-20,70,20),EMPTY,EMPTY)
        self.assertTrue(n['asphalt'].intersection(box(-30,-.8,30,.8)).is_empty)
    def test_native_cache_and_real_sample(self):
        d=load(CONFIG);self.assertLess(d['provenance']['max_roundtrip_error_m'],.001)
        self.assertEqual(d['provenance']['anchor_error_m'],0)
        report=json.loads((ROOT/CONFIG['output_dir']/'report.json').read_text(encoding='utf-8'))
        self.assertTrue(all(v<1e-5 for v in report['checks'].values()))
        self.assertGreater(report['counts']['mapped_crossings'],0)
    def test_full_source_topology_without_render_export(self):
        d=load(CONFIG);fs=[]
        for f in d['layers']['roads']['features']:fs.append({**f,'_geom':shape(f['geometry'])})
        extent=clean(shape(d['layers']['landuse']['features'][0]['geometry']).envelope)
        # The native cache and display AOI both cover the supplied test dataset.
        self.assertEqual(len(fs),337)
        grounds=[{'geom':f['_geom'],'width':7} for f in fs if f['properties']['highway'] in CONFIG['road_defaults'] and f['properties'].get('bridge')!='yes' and f['properties'].get('tunnel')!='yes']
        self.assertGreater(len(junctions(grounds)),50)
    def test_full_dataset_export_coverage(self):
        d=load(CONFIG);aoi=Polygon(d['aoi'])
        quality=json.loads((ROOT/'artifacts/guanlan-real/quality.json').read_text(encoding='utf-8'))
        self.assertEqual(CONFIG['bbox'],quality['bbox_wgs84'])
        self.assertAlmostEqual(aoi.area/1e6,quality['area_km2'],places=3)
        exported=json.loads((ROOT/CONFIG['output_dir']/'entities.json').read_text(encoding='utf-8'))
        expected=set()
        for f in d['layers']['roads']['features']:
            p=f['properties']
            if p['highway'] in CONFIG['road_defaults'] and p.get('bridge')!='yes' and p.get('tunnel')!='yes' and shape(f['geometry']).intersects(aoi):
                expected.add(f.get('id',p.get('@id')))
        self.assertTrue(expected.issubset({r['id'] for r in exported['roads']}))
        self.assertEqual(len(exported['buildings']),quality['counts']['buildings'])
    def test_mesh_has_indices_and_reproducible_bytes(self):
        mesh=Mesh();mesh.surface(box(0,0,3,3),.08,rgb('888888'))
        with tempfile.TemporaryDirectory() as t:
            a=Path(t)/'road.glb';mesh.save(a);first=a.read_bytes();mesh.save(a);self.assertEqual(first,a.read_bytes())
            n=struct.unpack_from('<I',first,12)[0];doc=json.loads(first[20:20+n]);primitive=doc['meshes'][0]['primitives'][0]
            self.assertIn('indices',primitive)
            self.assertEqual(doc['accessors'][primitive['indices']]['count'],6)
            self.assertEqual(doc['accessors'][primitive['attributes']['POSITION']]['count'],4)
            index_view=doc['bufferViews'][doc['accessors'][primitive['indices']]['bufferView']]
            indices=struct.unpack_from('<6I',first,28+n+index_view['byteOffset'])
            for attr,size,original in [('POSITION',3,mesh.v),('NORMAL',3,mesh.n),('TEXCOORD_0',2,mesh.uv),('COLOR_0',4,mesh.c)]:
                view=doc['bufferViews'][doc['accessors'][primitive['attributes'][attr]]['bufferView']]
                base=28+n+view['byteOffset']
                restored=[v for i in indices for v in struct.unpack_from('<'+'f'*size,first,base+i*size*4)]
                expected=struct.unpack('<'+'f'*len(original),struct.pack('<'+'f'*len(original),*original))
                self.assertEqual(restored,list(expected),attr)

if __name__=='__main__':unittest.main(verbosity=2)
