// NOAA 太陽幾何 —— 從 src/sunset/solar.py 逐式移植。
// Python 版為 canonical；本檔任何改動必須通過 parity 測試（web/test）。
// 台北無日光節約時間，固定 UTC+8。

export const SUNSET_ALTITUDE_DEG = -0.833;
export const CIVIL_TWILIGHT_ALTITUDE_DEG = -6.0;
export const GOLDEN_HOUR_ALTITUDE_DEG = 10.0;
export const SUN_DESCENT_DEG_PER_MIN = 0.21;
export const TAIPEI_UTC_OFFSET_H = 8;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

/** 太陽高度角/方位角（NOAA）。tMs 為 epoch 毫秒。 */
export function sunPosition(tMs, lat, lon) {
  const jd = tMs / 86400000 + 2440587.5;
  const jc = (jd - 2451545.0) / 36525.0;

  const geomMeanLong = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360.0;
  const geomMeanAnom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const eccent = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);

  const anomRad = rad(geomMeanAnom);
  const eqOfCtr =
    Math.sin(anomRad) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * anomRad) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * anomRad) * 0.000289;
  const trueLong = geomMeanLong + eqOfCtr;
  const omega = rad(125.04 - 1934.136 * jc);
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega);

  const meanObliq =
    23.0 + (26.0 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(omega);
  const obliqRad = rad(obliqCorr);
  const appLongRad = rad(appLong);

  const declination = Math.asin(Math.sin(obliqRad) * Math.sin(appLongRad));

  const varY = Math.tan(obliqRad / 2.0) ** 2;
  const geomLongRad = rad(geomMeanLong);
  const eqOfTimeMin =
    4.0 *
    deg(
      varY * Math.sin(2 * geomLongRad) -
        2 * eccent * Math.sin(anomRad) +
        4 * eccent * varY * Math.sin(anomRad) * Math.cos(2 * geomLongRad) -
        0.5 * varY * varY * Math.sin(4 * geomLongRad) -
        1.25 * eccent * eccent * Math.sin(2 * anomRad),
    );

  const d = new Date(tMs);
  const minutesUtc = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const trueSolarMin = (((minutesUtc + eqOfTimeMin + 4.0 * lon) % 1440.0) + 1440.0) % 1440.0;
  const hourAngle = trueSolarMin / 4.0 - 180.0;
  const haRad = rad(hourAngle);
  const latRad = rad(lat);

  const cosZenith = clamp1(
    Math.sin(latRad) * Math.sin(declination) +
      Math.cos(latRad) * Math.cos(declination) * Math.cos(haRad),
  );
  const zenith = Math.acos(cosZenith);
  const altitude = 90.0 - deg(zenith);

  const sinZenith = Math.sin(zenith);
  let azimuth;
  if (Math.abs(sinZenith) < 1e-9) {
    azimuth = 180.0;
  } else {
    const cosAz = clamp1(
      (Math.sin(latRad) * Math.cos(zenith) - Math.sin(declination)) /
        (Math.cos(latRad) * sinZenith),
    );
    const az = deg(Math.acos(cosAz));
    azimuth = hourAngle > 0 ? (az + 180.0) % 360.0 : (540.0 - az) % 360.0;
  }
  return { altitudeDeg: altitude, azimuthDeg: azimuth };
}

/** 台北時間 (y,m,d,h,min) → epoch ms。 */
export function taipeiMs(y, m, d, h, min = 0) {
  return Date.UTC(y, m - 1, d, h - TAIPEI_UTC_OFFSET_H, min);
}

function findAltitudeCrossing(y, m, d, lat, lon, altitudeDeg, startH, endH) {
  let lo = taipeiMs(y, m, d, startH);
  let hi = taipeiMs(y, m, d, endH);
  const fLo = sunPosition(lo, lat, lon).altitudeDeg - altitudeDeg;
  const fHi = sunPosition(hi, lat, lon).altitudeDeg - altitudeDeg;
  if (fLo < 0 || fHi > 0) return null;
  for (let i = 0; i < 40; i++) {
    const mid = lo + (hi - lo) / 2;
    if (sunPosition(mid, lat, lon).altitudeDeg - altitudeDeg > 0) lo = mid;
    else hi = mid;
  }
  return lo + (hi - lo) / 2;
}

/** dateStr "YYYY-MM-DD" → {y,m,d} */
function parts(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { y, m, d };
}

export function sunsetTimeMs(dateStr, lat, lon) {
  const { y, m, d } = parts(dateStr);
  return findAltitudeCrossing(y, m, d, lat, lon, SUNSET_ALTITUDE_DEG, 15, 21);
}

export function sunsetAzimuth(dateStr, lat, lon) {
  const t = sunsetTimeMs(dateStr, lat, lon);
  return t === null ? null : sunPosition(t, lat, lon).azimuthDeg;
}

export function goldenHourStartMs(dateStr, lat, lon) {
  const { y, m, d } = parts(dateStr);
  return findAltitudeCrossing(y, m, d, lat, lon, GOLDEN_HOUR_ALTITUDE_DEG, 12, 21);
}

export function civilTwilightEndMs(dateStr, lat, lon) {
  const { y, m, d } = parts(dateStr);
  return findAltitudeCrossing(y, m, d, lat, lon, CIVIL_TWILIGHT_ALTITUDE_DEG, 15, 22);
}
