"""Deterministic additional tree layer; DENSITY_FACTOR is relative to base planting."""
import json, math, random, re
from pathlib import Path
from collections import defaultdict
from terrain_form import height, park_clear
DENSITY_FACTOR=1.20
PARKS=[(-430,280),(-110,-40),(50,-40),(370,-200)]
XS=[-510,-350,-190,-30,130,290,450]
YS=[-440,-280,-120,40,200,360]

def read_trees(path):
    rows=[]
    for line in path.read_text(encoding='utf8').splitlines():
        match=re.search(r'Instances \{ id: (tree[0-2])Batch',line)
        if not match:continue
        def field(n):return json.loads(re.search(n+r': (\[.*?\])(?:;| \})',line).group(1))
        rows.extend((match[1],p,a,s) for p,a,s in zip(field('positions'),field('rotations_z'),field('scales')))
    return rows

def build(project):
    project=Path(project);rng=random.Random(92020)
    base=read_trees(project/'Planting.ssdl')+read_trees(project/'ParkGardens.ssdl')
    buckets=defaultdict(list)
    for row in base:
        x,y,_=row[1]
        park=next((i for i,(cx,cy) in enumerate(PARKS) if abs(x-cx)<65 and abs(y-cy)<65),None)
        if park is not None:kind='park'+str(park)
        elif -550<x<490 and -470<y<400:kind='street'
        else:kind='forest'
        buckets[kind].append(row)
    occupied=[r[1][:2] for r in base];added=[];counts={}
    target=round(len(base)*(DENSITY_FACTOR-1))
    for kind,items in sorted(buckets.items(),key=lambda kv:kv[0]=='forest'):
        count=target-len(added) if kind=='forest' else round(len(items)*(DENSITY_FACTOR-1))
        accepted=0
        for attempt in range(count*1000):
            if accepted==count:break
            name,p,angle,scale=rng.choice(items);x,y=p[:2];ss=scale[0]
            if kind.startswith('park'):
                cx,cy=PARKS[int(kind[-1])];dx,dy=x-cx,y-cy
                if math.hypot(dx,dy)>50:
                    a=math.atan2(dy,dx)+rng.choice([-1,1])*math.pi/28
                    x,y=cx+59*math.cos(a),cy+59*math.sin(a)
                    if not park_clear(x-cx,y-cy,3.5):continue
                    spacing=5.8
                else:
                    x,y=cx+rng.uniform(-36,36),cy+rng.uniform(-36,36)
                    if not park_clear(x-cx,y-cy,3.5):continue
                    spacing=6;ss=.48
                z=.38
            elif kind=='street':
                if min(abs(abs(x-xx)-20) for xx in XS)<.02:
                    y+=rng.choice([-1,1])*12.5
                    if min(abs(y-yy) for yy in YS)<24 or not -420<y<380:continue
                else:
                    x+=rng.choice([-1,1])*13
                    if min(abs(x-xx) for xx in XS)<24 or not -485<x<451:continue
                z=height(x,y);spacing=9
            else:
                x+=rng.uniform(-24,24);y+=rng.uniform(-24,24)
                # Conservative exclusion of city, river, elevated highway and southern viaduct.
                if -940<x<760 and y<740:continue
                if 440<y<720 or not -1790<x<1790 or not -890<y<2340:continue
                z=height(x,y);spacing=7
            if any((x-u)**2+(y-v)**2<spacing**2 for u,v in occupied):continue
            p=[round(x,2),round(y,2),round(z,2)]
            occupied.append(p[:2]);added.append((name,p,rng.randrange(360),[ss]*3));accepted+=1
        assert accepted==count,(kind,accepted,count)
        counts[kind]={'before':len(items),'added':accepted}
    out=['Group {','id: root'];byname=defaultdict(list)
    for name,p,a,s in added:byname[name].append((p,a,s))
    js=lambda v:json.dumps(v,separators=(',',':'))
    for name,rows in byname.items():
        out += [f'Model {{ id: {name}Source; source: "assets/{name}.glb"; visible: false }}',f'Prefab {{ id: {name}Prefab; source: {name}Source }}']
        for offset in range(0,len(rows),480):
            rr=rows[offset:offset+480]
            out.append(f'Instances {{ id: {name}Batch{offset}; prefab: {name}Prefab; positions: {js([r[0] for r in rr])}; rotations_z: {js([r[1] for r in rr])}; scales: {js([r[2] for r in rr])} }}')
    out.append('}');(project/'TreeDensity.ssdl').write_text('\n'.join(out)+'\n',encoding='utf8')
    info={'factor':DENSITY_FACTOR,'before':len(base),'added':len(added),'total':len(base)+len(added),'regions':counts}
    (project/'tree-density.json').write_text(json.dumps(info,indent=2),encoding='utf8')
    return info

if __name__=='__main__':print(json.dumps(build(Path(__file__).parent),indent=2))
