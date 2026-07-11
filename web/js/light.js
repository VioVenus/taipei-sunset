// 光線相位引擎：由太陽時間表推導「現在的光」。純時間數學、離線可用；
// 顯示文字（名稱/建議）由 i18n 依 key 提供（light.<key>.*）。
// 領域重點：火燒雲的高峰常在「日落後 10–20 分鐘」（afterglow 餘燼窗口）——
// 最常見的失誤是太陽一沒入就收工走人。

export const PHASE_EMOJI = { day: "☀️", golden: "🌇", afterglow: "🔥", night: "🌃" };

/** 由太陽時間表與現在時刻推導光線相位。
 * @param {{goldenStartMs:number, sunsetMs:number, civilTwilightEndMs:number}} sun
 * @param {number} nowMs
 * @returns {{key: "day"|"golden"|"afterglow"|"night", untilMs: number|null, progress: number|null}}
 *   untilMs = 下一個相位邊界；progress = 目前相位進度 0–1（day/night 為 null）。
 */
export function lightPhase(sun, nowMs) {
  const { goldenStartMs: g, sunsetMs: s, civilTwilightEndMs: c } = sun;
  if (nowMs < g) return { key: "day", untilMs: g, progress: null };
  if (nowMs < s) return { key: "golden", untilMs: s, progress: (nowMs - g) / (s - g) };
  if (nowMs < c) return { key: "afterglow", untilMs: c, progress: (nowMs - s) / (c - s) };
  return { key: "night", untilMs: null, progress: null };
}

/** 距 untilMs 還有幾分鐘（不出現負數）。 */
export function minutesUntil(untilMs, nowMs) {
  return Math.max(0, Math.round((untilMs - nowMs) / 60000));
}
