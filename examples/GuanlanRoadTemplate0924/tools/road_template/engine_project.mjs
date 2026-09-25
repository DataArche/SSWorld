/** All geographic coordinate conversion is performed by SSEngine's native WASM API. */
export function projectDataset(M, input) {
  const ellipsoid = M.Ellipsoid.WGS84();
  const origin = M.Cartesian3.fromDegrees(...input.anchor);
  const localToWorld = ellipsoid.eastNorthUpToFixedFrame(origin);
  const worldToLocal = localToWorld.inverted();
  let count = 0, maxRoundtripM = 0, minZ = Infinity, maxZ = -Infinity;
  const cache = new Map();
  const release = (...objects) => objects.forEach(o => o?.delete?.());
  function point(c) {
    const key = JSON.stringify(c);
    if (cache.has(key)) return cache.get(key);
    // No DEM: use the nominal anchor ellipsoid height, then keep XY for a planar design surface.
    const world = M.Cartesian3.fromDegrees(c[0], c[1], c.length > 2 ? c[2] : input.anchor[2]);
    const vector = world.toVector3();
    const local = worldToLocal.map(vector);
    const back = localToWorld.map(local);
    maxRoundtripM = Math.max(maxRoundtripM, Math.hypot(back.x - world.x, back.y - world.y, back.z - world.z));
    minZ = Math.min(minZ, local.z); maxZ = Math.max(maxZ, local.z);
    const result = [local.x, local.y];
    if (!result.every(Number.isFinite)) throw Error('SSEngine returned non-finite coordinates');
    cache.set(key, result); count++;
    release(back, local, vector, world);
    return result;
  }
  const coordinates = c => typeof c[0] === 'number' ? point(c) : c.map(coordinates);
  try {
    const layers = Object.fromEntries(Object.entries(input.layers).map(([k, fc]) => [k, {
      type: 'FeatureCollection', features: fc.features.map(f => ({...f, geometry: {
        ...f.geometry, coordinates: coordinates(f.geometry.coordinates)
      }}))
    }]));
    const [w,s,e,n] = input.bbox;
    const aoi = [[w,s],[e,s],[e,n],[w,n],[w,s]].map(point);
    const views = Object.fromEntries(Object.entries(input.views).map(([k,v]) => [k,point(v)]));
    const anchorLocal = point(input.anchor);
    if (Math.hypot(...anchorLocal) > 0.001 || maxRoundtripM > 0.001) throw Error('Native projection accuracy gate failed');
    return {schema:'RoadTemplateProjection/1', input_digest:input.input_digest, anchor:input.anchor,
      bbox:input.bbox, aoi, views, layers, provenance:{
        api:['SSmap.Cartesian3.fromDegrees','SSmap.Ellipsoid.WGS84().eastNorthUpToFixedFrame','SSmap.Matrix4.inverted','SSmap.Matrix4.map'],
        unique_points:count, max_roundtrip_error_m:maxRoundtripM, anchor_error_m:Math.hypot(...anchorLocal),
        native_z_range_m:[minZ,maxZ], surface:'Planar design reference; native XY retained; native Z not treated as terrain',
        engine:input.engine_fingerprint
      }};
  } finally { release(worldToLocal, localToWorld, origin); }
}

export async function runProjection(M, endpoint='http://127.0.0.1:8894') {
  const input = await (await fetch(endpoint+'/input', {cache:'no-store'})).json();
  const result = projectDataset(M,input);
  const response = await fetch(endpoint+'/result', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
  if (!response.ok) throw Error(await response.text());
  return result.provenance;
}
