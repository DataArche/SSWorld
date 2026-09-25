"""Partition dynamic instances by SSEngine's instance and triangle quotas."""
import json,struct

def triangle_count(path):
    raw=path.read_bytes();size=struct.unpack_from('<I',raw,12)[0]
    doc=json.loads(raw[20:20+size])
    def visit(i):
        node=doc['nodes'][i];n=0
        if 'mesh' in node:
            for p in doc['meshes'][node['mesh']]['primitives']:
                if p.get('mode',4)!=4:raise ValueError('Furniture must use triangle primitives')
                accessor=p.get('indices',p['attributes']['POSITION'])
                n+=doc['accessors'][accessor]['count']//3
        return n+sum(visit(c) for c in node.get('children',[]))
    return sum(visit(i) for i in doc['scenes'][doc.get('scene',0)]['nodes'])

def write_furniture(out,sources):
    """sources: {model: {group: {positions, rotations_z?, scales_uniform?}}}.

    Writes StreetFurniture.ssdl (one hidden Model per model, one Prefab + empty Instances per batch)
    and furniture-rows.json as {group: {instances_id: rows}}; logic.mjs fills the batches at runtime
    because static instances do not follow their parent Group's visibility.
    """
    ssdl=['Group {',' id: root'];result={}
    for model,groups in sources.items():
        groups={g:r for g,r in groups.items() if r['positions']}
        if not groups:continue
        triangles=triangle_count(out/'assets'/(model+'.glb'))
        # Each batch gets its own Prefab, so the per-Prefab instance and triangle quotas never add up.
        capacity=min(512,2048,1_000_000//max(1,triangles))
        if capacity<1:raise ValueError('Furniture model exceeds native prefab triangle quota')
        ssdl.append(f'Model {{ id: {model}; source: "assets/{model}.glb"; position: [0, 0, -100] }}')
        for group,rows in groups.items():
            for start in range(0,len(rows['positions']),capacity):
                name=f'{model}__{group}_{start}';prefab='prefab_'+name
                ssdl.extend([f'Prefab {{ id: {prefab}; source: {model} }}',f'Instances {{ id: {name}; prefab: {prefab}; placement: "explicit"; positions: [] }}'])
                result.setdefault(group,{})['furniture__'+name]={k:v[start:start+capacity] for k,v in rows.items()}
    ssdl.append('}')
    (out/'StreetFurniture.ssdl').write_text('\n'.join(ssdl),encoding='utf-8')
    (out/'furniture-rows.json').write_text(json.dumps(result),encoding='utf-8')
    return result

def batch_model(batch_id):
    """furniture__<model>__<group>_<start> -> <model>."""
    return batch_id.split('__')[1]

def regroup(rows):
    """Inverse of write_furniture's output: {group: {id: rows}} -> sources."""
    sources={}
    for group,batches in rows.items():
        for batch_id,batch in batches.items():
            dest=sources.setdefault(batch_model(batch_id),{}).setdefault(group,{k:[] for k in batch})
            for k,v in batch.items():dest[k].extend(v)
    return sources
