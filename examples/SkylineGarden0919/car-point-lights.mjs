// One front point light per car. Rear lenses remain emissive only.
//
// Every write in here is a native call on the browser's main thread, and writing all 351 of them
// every tick was 86% of that thread at night. Three budgets cut the traffic without changing what
// the camera can see:
//   * only the LIT_BUDGET cars nearest the camera carry a live PointLight. attenuationRadius is
//     15 m, so a light further away than those lights nothing that ends up on screen;
//   * a car whose lamp moved less than MOVE_EPSILON since its last write is not written again,
//     which is what makes a stopped queue and a paused scene free;
//   * fragments still sitting on the native spawn queue are retried because the host reports the
//     ids it could not resolve, not by repeating the whole round forever.
const LIT_BUDGET = 48;
const MOVE_EPSILON = 0.05;      // metres
const FRONT_OFFSET = 2.65, LAMP_HEIGHT = 1.05;

// Same WGS84 -> ENU frame the runtime writes every SSDL position in: x east, y north, z up at the
// project anchor. The host hands back the live camera in degrees; the cars are in local metres.
const DEG = Math.PI / 180, WGS84_A = 6378137, WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
function geodeticToEcef(lonDeg, latDeg, height) {
  const lon = lonDeg * DEG, lat = latDeg * DEG, sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return { x: (n + height) * cosLat * Math.cos(lon), y: (n + height) * cosLat * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + height) * sinLat };
}
export function geodeticToEnu(anchor, longitude, latitude, height) {
  const origin = geodeticToEcef(anchor.lon, anchor.lat, anchor.height);
  const point = geodeticToEcef(longitude, latitude, height);
  const dx = point.x - origin.x, dy = point.y - origin.y, dz = point.z - origin.z;
  const lon = anchor.lon * DEG, lat = anchor.lat * DEG;
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon), sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  return {
    x: -sinLon * dx + cosLon * dy,
    y: -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz,
    z: cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz,
  };
}

/**
 * Indices of the `count` cars closest to `camera`, ranked in the ground plane: the camera sits at
 * one height above all of them, so it cannot change the order. Without a camera every car is a
 * candidate and the first `count` win, which keeps the budget rather than lighting all 351.
 */
export function nearestCars(cars, camera, count) {
  if (cars.length <= count) return cars.map((_, index) => index);
  const ranked = cars.map((car, index) => {
    const dx = car.at[0] - camera.x, dy = car.at[1] - camera.y;
    return [dx * dx + dy * dy, index];
  });
  ranked.sort((a, b) => a[0] - b[0]);
  return ranked.slice(0, count).map(([, index]) => index);
}

export function createVehiclePointLights(api) {
  const handles = new Map();     // tag -> fragment handle
  const levels = new Map();      // tag -> level the fragment currently holds
  const written = new Map();     // tag -> world position the facade accepted
  // The camera can only be missing before the scene has mounted; keeping the last reading is what
  // stops a one-frame gap from falling back to all 351 lights.
  let camera = { x: 0, y: 0 };
  function readCamera() {
    if (typeof api.cameraGeodetic !== "function") return camera;
    const geodetic = api.cameraGeodetic();
    if (!geodetic || !Number.isFinite(geodetic.longitude) || !Number.isFinite(geodetic.latitude)) return camera;
    camera = geodeticToEnu(api.anchor, geodetic.longitude, geodetic.latitude, geodetic.height || 0);
    return camera;
  }
  return {
    update(rows, level) {
      const cars = rows.flatMap((row, color) => row.positions.map((at, i) =>
        ({ tag: `car-light:${color}:${i}`, at, heading: row.rotations_z[i] })));
      if (!handles.size) {
        // Reuse the runtime's replayed fragments after an SSDL hot reload.
        for (const item of api.scene.list()) if (item.name === 'VehiclePointLights' && item.tag?.startsWith('car-light:')) handles.set(item.tag, item.handle);
        if (!handles.size && level <= .001) return;
      }
      if (level > .001) for (const car of cars) if (!handles.has(car.tag)) {
        const { handle } = api.scene.spawn('VehiclePointLights', { level: 0 }, { at: [0, 0, 0], tag: car.tag });
        handles.set(car.tag, handle);
        // Spawned dark, so nothing has to be written to keep it dark. A handle picked up from a hot
        // reload's replay is deliberately left unknown: its level is written once, explicitly.
        levels.set(car.tag, 0);
      }

      const lit = level > .001
        ? new Set(nearestCars(cars, readCamera(), LIT_BUDGET).map((index) => cars[index].tag))
        : new Set();
      // A parameter write also reapplies the fragment's AUTHORED position, so a light that takes one
      // has to have its world position written again in the same round; one that goes dark has to
      // forget where it was, because it is no longer there.
      const value = level * .25, reapplied = new Set();
      for (const car of cars) {
        const handle = handles.get(car.tag);
        if (!handle) continue;
        const target = lit.has(car.tag) ? value : 0;
        if (levels.get(car.tag) === target) continue;
        api.scene.set(handle, 'level', target);
        levels.set(car.tag, target);
        if (target > 0) reapplied.add(car.tag); else written.delete(car.tag);
      }

      const updates = [];
      for (const car of cars) {
        if (!lit.has(car.tag)) continue;
        const handle = handles.get(car.tag);
        if (!handle) continue;
        const a = car.heading * Math.PI / 180;
        const position = [car.at[0] + Math.cos(a) * FRONT_OFFSET, car.at[1] + Math.sin(a) * FRONT_OFFSET, car.at[2] + LAMP_HEIGHT];
        const last = written.get(car.tag);
        if (last && !reapplied.has(car.tag)
          && Math.abs(last[0] - position[0]) < MOVE_EPSILON
          && Math.abs(last[1] - position[1]) < MOVE_EPSILON
          && Math.abs(last[2] - position[2]) < MOVE_EPSILON) continue;
        updates.push({ id: handle + '/fragment-root__front', position, tag: car.tag });
      }
      if (!updates.length) return;
      const missing = new Set(api.carLightPositions(updates) || []);
      for (const item of updates) {
        // An id the facade has no component for is a fragment still queued on the native side.
        // Leaving it unrecorded is what brings it back next tick, once, instead of forever.
        if (missing.has(item.id)) written.delete(item.tag); else written.set(item.tag, item.position);
      }
    },
  };
}
