// 組裝層 —— 對齊 src/sunset/analysis.py 的判定門檻與 preliminary 紀律。

import {
  civilTwilightEndMs,
  goldenHourStartMs,
  sunPosition,
  sunsetAzimuth,
  sunsetTimeMs,
  TAIPEI_UTC_OFFSET_H,
} from "./solar.js";
import { assessAlignment, assessObstruction } from "./geometry.js";
import { dynamicHalfWidth, score } from "./scoring.js";

export const VERDICT_GO_CD_MIN = 25.0;
export const VERDICT_GO_VISIBLE_MIN = 50.0;
export const PRELIMINARY_CUTOFF_HOUR = 12;
export const CONVECTION_PRECIP_PROB = 30.0;
export const MAX_QUERY_DAYS_AHEAD = 3;

export const VERDICT_GO = "出發";
export const VERDICT_SKIP = "跳過";
export const VERDICT_NO_DATA = "資料不足";

/** 現在時刻的台北日期字串與小時。 */
export function taipeiNow(nowMs = Date.now()) {
  const t = new Date(nowMs + TAIPEI_UTC_OFFSET_H * 3600000);
  const dateStr = t.toISOString().slice(0, 10);
  return { dateStr, hour: t.getUTCHours() };
}

/** 單點分析（天氣由呼叫端先取得，便於多點位共用/測試）。 */
export function analyze(dateStr, viewpoint, weather, nowMs = Date.now()) {
  const sunsetMs = sunsetTimeMs(dateStr, viewpoint.lat, viewpoint.lon);
  const azimuth = sunsetAzimuth(dateStr, viewpoint.lat, viewpoint.lon);
  const sun = {
    sunsetMs,
    sunsetAzimuthDeg: azimuth,
    goldenStartMs: goldenHourStartMs(dateStr, viewpoint.lat, viewpoint.lon),
    civilTwilightEndMs: civilTwilightEndMs(dateStr, viewpoint.lat, viewpoint.lon),
  };
  const alignment = assessAlignment(viewpoint, azimuth);
  const obstruction = assessObstruction(viewpoint, azimuth);
  const effectiveSunsetMs = sunsetMs - obstruction.earlyMinutes * 60000;

  let probs = null;
  if (weather && weather.ok) {
    probs = score({
      cloudLow: weather.cloudLow ?? 0,
      cloudMid: weather.cloudMid ?? 0,
      cloudHigh: weather.cloudHigh ?? 0,
      precipProbEvening: weather.precipProbEvening ?? 0,
      burnedYesterday: Boolean(weather.burnedYesterday),
      rainClearing: Boolean(weather.rainRecentFlag),
      frontWithin48h: Boolean(weather.frontWithin48h),
    });
  }

  let verdict;
  if (probs === null) verdict = VERDICT_NO_DATA;
  else if (alignment.level === "警告") verdict = VERDICT_SKIP;
  else if (probs.burnLevel >= VERDICT_GO_CD_MIN && probs.sunsetVisible >= VERDICT_GO_VISIBLE_MIN)
    verdict = VERDICT_GO;
  else verdict = VERDICT_SKIP;

  const now = taipeiNow(nowMs);
  const preliminary =
    now.dateStr < dateStr || (now.dateStr === dateStr && now.hour < PRELIMINARY_CUTOFF_HOUR);

  return {
    targetDate: dateStr,
    viewpoint,
    sun,
    alignment,
    obstruction,
    effectiveSunsetMs,
    weather,
    probs,
    verdict,
    preliminary,
    intervalHalfWidth: dynamicHalfWidth(weather?.modelSpread ?? null),
  };
}

/** 點位推薦：排除警告；對流風險日避開有 weather_exclusion 的點位；取 C+D 最高。 */
export function recommend(results) {
  const candidates = results.filter((r) => r.probs !== null && r.alignment.level !== "警告");
  if (candidates.length === 0) return null;
  const key = (r) => {
    const precip = r.weather?.precipProbWindow ?? 0;
    const penalty = r.viewpoint.weather_exclusion && precip > CONVECTION_PRECIP_PROB ? 100 : 0;
    return [-penalty, r.probs.burnLevel];
  };
  return candidates.reduce((best, r) => {
    const [pb, bb] = key(best);
    const [pr, br] = key(r);
    return pr > pb || (pr === pb && br > bb) ? r : best;
  });
}

/** 太陽位置（供時間軸「現在」打點用）。 */
export function sunAltitudeNow(viewpoint, nowMs = Date.now()) {
  return sunPosition(nowMs, viewpoint.lat, viewpoint.lon).altitudeDeg;
}
