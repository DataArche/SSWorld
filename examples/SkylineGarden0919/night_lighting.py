"""Lights use the exact coordinates of the existing pole and garden lamp meshes."""
import math,json
def build(env):
    write,P=env['write'],env['P']
    street=[[x,y+17,9.25] for y in env['ys'] for x in range(-480,450,55)]
    garden=[]
    for lot in env['lots']:
        if lot['type']!='park':continue
        for i in range(8):
            a=(i+.5)*math.pi/4
            garden.append([round(lot['x']+50*math.cos(a),4),round(lot['y']+50*math.sin(a),4),3.75])
    lines=['property real level: 0']
    for i,p in enumerate(street):
        lines.append(f'PointLight {{ id: roadLight{i}; position: {json.dumps(p)}; intensity: 100000 * level; lightColor: "#ffe0a3"; attenuationRadius: 36; sourceRadius: 0.28; castShadows: false }}')
    for i,p in enumerate(garden):
        lines.append(f'PointLight {{ id: gardenLight{i}; position: {json.dumps(p)}; intensity: 20000 * level; lightColor: "#ffe5b1"; attenuationRadius: 18; sourceRadius: 0.22; castShadows: false }}')
    write('NightLighting',lines)
    glow=['property real level: 0','Sphere { id: bulb; radius: 0.48; segments: 12; visible: false; UnlitMaterial { baseColor: "#fff0cf"; opacity: level > 0.01 ? 1 : 0; emissiveColor: [16,11.2,5.2] } }','Prefab { id: bulbPrefab; source: bulb }',f'Instances {{ id: lamps; prefab: bulbPrefab; positions: {json.dumps(street+garden)} }}']
    write('NightBulbs',glow)
    (P/'lighting-layout.json').write_text(json.dumps({'street_lights':len(street),'garden_lights':len(garden),'total':len(street+garden),'positions':street+garden},indent=2))
