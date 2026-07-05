// 視線幾何 —— 從 src/sunset/geometry.py 逐式移植（Python 為 canonical）。

import { SUN_DESCENT_DEG_PER_MIN } from "./solar.js";

export const EARTH_RADIUS_KM = 6371.0088;
export const ALIGNMENT_GOOD_MAX_DIFF_DEG = 25.0;
export const ALIGNMENT_WARN_MIN_DIFF_DEG = 45.0;

const rad = (d) => (d * Math.PI) / 180;

export function distanceKm(lat1, lon1, lat2, lon2) {
  const phi1 = rad(lat1);
  const phi2 = rad(lat2);
  const dphi = rad(lat2 - lat1);
  const dlmb = rad(lon2 - lon1);
  const a =
    Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlmb / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = rad(lat1);
  const phi2 = rad(lat2);
  const dlmb = rad(lon2 - lon1);
  const x = Math.sin(dlmb) * Math.cos(phi2);
  const y = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlmb);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

function angularDiff(a, b) {
  const d = Math.abs(a - b) % 360.0;
  return d > 180.0 ? 360.0 - d : d;
}

function inAzimuthRange(azimuth, [lo, hi]) {
  const az = ((azimuth % 360) + 360) % 360;
  if (lo <= hi) return lo <= az && az <= hi;
  return az >= lo || az <= hi;
}

/** 對位判定：level ∈ 良好/普通/警告。 */
export function assessAlignment(viewpoint, sunsetAzimuth) {
  let diff;
  if (inAzimuthRange(sunsetAzimuth, viewpoint.open_azimuth_range)) {
    diff = 0.0;
  } else {
    diff = Math.min(
      angularDiff(sunsetAzimuth, viewpoint.open_azimuth_range[0]),
      angularDiff(sunsetAzimuth, viewpoint.open_azimuth_range[1]),
    );
  }
  let level;
  let message;
  const azTxt = sunsetAzimuth.toFixed(1);
  if (diff <= ALIGNMENT_GOOD_MAX_DIFF_DEG) {
    level = "良好";
    message = `日落方位 ${azTxt}° 對位良好（開闊視線內或差 ≤25°）`;
  } else if (diff >= ALIGNMENT_WARN_MIN_DIFF_DEG) {
    level = "警告";
    message = `⚠️ 日落方位 ${azTxt}° 在遮蔽物後方／背後（差 ${diff.toFixed(0)}°），此點位不適合`;
  } else {
    level = "普通";
    message = `日落方位 ${azTxt}° 偏離開闊視線 ${diff.toFixed(0)}°，部分視野受限`;
  }
  return { level, azimuthDiffDeg: diff, message };
}

export function obstructionEarlyMinutes(angleDeg) {
  return angleDeg / SUN_DESCENT_DEG_PER_MIN;
}

export function assessObstruction(viewpoint, sunsetAzimuth) {
  let best = null;
  for (const obs of viewpoint.horizon_obstruction || []) {
    if (inAzimuthRange(sunsetAzimuth, obs.azimuth_range)) {
      if (best === null || obs.angle_deg > best.angle_deg) best = obs;
    }
  }
  if (best === null) return { angleDeg: 0, earlyMinutes: 0, note: "", matched: false };
  return {
    angleDeg: best.angle_deg,
    earlyMinutes: obstructionEarlyMinutes(best.angle_deg),
    note: best.note || "",
    matched: true,
  };
}
