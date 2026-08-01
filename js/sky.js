/**
 * Ground-station geometry for "what is over this address right now".
 *
 * Two coordinate conventions live here, on purpose:
 *  - The globe mesh is a perfect sphere with a plate-carrée texture, so the
 *    map pin uses spherical lat/lon → scene (matches what you see).
 *  - Look angles use satellite.js WGS84 helpers, so elevation / azimuth /
 *    range are the real numbers you'd point an antenna with.
 */

const DEG = Math.PI / 180;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/**
 * Lat/lon on the textured sphere. The scene maps ECEF (x, y, z) → (x, z, -y),
 * so 0°N 0°E sits on +X and the north pole on +Y.
 */
export function latLonToScene(latDeg, lonDeg, radius = 1) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const cl = Math.cos(lat);
  return {
    x: cl * Math.cos(lon) * radius,
    y: Math.sin(lat) * radius,
    z: -cl * Math.sin(lon) * radius,
  };
}

/**
 * Everything above the observer's horizon, brightest-overhead first.
 *
 * Reads positions straight out of the render buffer (already propagated this
 * tick) instead of re-running SGP4 for 16k objects.
 */
export function findOverhead({
  observer,
  positions,
  visible,
  count,
  kmToScene,
  minElevationDeg = 0,
}) {
  const gd = observerGd(observer);
  const obs = satellite.geodeticToEcf(gd);
  const obsLen = Math.hypot(obs.x, obs.y, obs.z);
  const nx = obs.x / obsLen;
  const ny = obs.y / obsLen;
  const nz = obs.z / obsLen;
  // Cheap spherical horizon reject before the exact look angle; the 0.98 slack
  // covers the ellipsoid-vs-sphere difference so nothing real gets dropped.
  const horizonCut = obsLen * 0.98;
  const minEl = minElevationDeg * DEG;
  const inv = 1 / kmToScene;

  const rows = [];
  let aboveHorizon = 0;

  for (let i = 0; i < count; i++) {
    if (!visible[i]) continue;
    const ecf = sceneToEcf(positions, i, inv);
    if (!ecf) continue;
    if (ecf.x * nx + ecf.y * ny + ecf.z * nz < horizonCut) continue;

    const look = satellite.ecfToLookAngles(gd, ecf);
    if (look.elevation <= 0) continue;
    aboveHorizon++;
    if (look.elevation < minEl) continue;

    rows.push({ i, ...toDegrees(look) });
  }

  rows.sort((a, b) => b.elevation - a.elevation);
  return { rows, aboveHorizon };
}

/** Look angle to one satellite, whatever the list is currently filtered to. */
export function lookAngleAt({ observer, positions, index, kmToScene }) {
  const ecf = sceneToEcf(positions, index, 1 / kmToScene);
  if (!ecf) return null;
  return toDegrees(satellite.ecfToLookAngles(observerGd(observer), ecf));
}

function observerGd(observer) {
  return {
    latitude: observer.lat * DEG,
    longitude: observer.lon * DEG,
    height: observer.altKm || 0,
  };
}

/** Render buffer (x, z, -y) → ECEF km, or null when the slot is empty. */
function sceneToEcf(positions, i, inv) {
  const x = positions[i * 3] * inv;
  const z = positions[i * 3 + 1] * inv;
  const y = -positions[i * 3 + 2] * inv;
  return (x === 0 && y === 0 && z === 0) ? null : { x, y, z };
}

function toDegrees(look) {
  return {
    elevation: look.elevation / DEG,
    azimuth: ((look.azimuth / DEG) + 360) % 360,
    rangeKm: look.rangeSat,
  };
}

export function compass(azimuthDeg) {
  const a = ((azimuthDeg % 360) + 360) % 360;
  return COMPASS[Math.round(a / 22.5) % 16];
}

/** Sub-satellite point (lat/lon/alt) from a live satrec + time. */
export function subpointOf(satrec, date = new Date()) {
  if (!satrec) return null;
  const pv = satellite.propagate(satrec, date);
  if (!pv?.position) return null;
  const gmst = satellite.gstime(date);
  const gd = satellite.eciToGeodetic(pv.position, gmst);
  return {
    lat: satellite.degreesLat(gd.latitude),
    lon: satellite.degreesLong(gd.longitude),
    altKm: gd.height,
  };
}
