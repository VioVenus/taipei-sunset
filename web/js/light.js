// 光線相位引擎：由太陽時間表推導「現在的光」＋對應行動/拍攝建議。
// 純函式、僅用既有 solar 邊界（黃金起/日落/藍調終），離線可用。
// 領域重點：火燒雲的高峰常在「日落後 10–20 分鐘」（餘燼窗口）——
// 最常見的失誤是太陽一沒入就收工走人。

export const PHASES = {
  day: {
    key: "day",
    emoji: "☀️",
    name: "白天",
    heading: "距黃金時段還有一段時間",
    tips: [
      "先看判定與雷達，決定要不要出門",
      "拍攝：這段光平淡，適合探點、找前景構圖",
    ],
  },
  golden: {
    key: "golden",
    emoji: "🌇",
    name: "黃金時段",
    heading: "低角度暖光進行中",
    tips: [
      "順光拍人像膚色最好；逆光試剪影＋星芒（縮光圈 f/11–16）",
      "測光對天空、對暗部補光或包圍曝光（±2EV）",
    ],
  },
  afterglow: {
    key: "afterglow",
    emoji: "🔥",
    name: "餘燼窗口",
    heading: "別走！火燒雲高峰常在日落後 10–20 分鐘",
    tips: [
      "雲由金轉粉紅→紫紅是正要燒的訊號，再等 5 分鐘",
      "光線快速變暗：上腳架或提 ISO，白平衡固定「陰天」保留暖色",
    ],
  },
  night: {
    key: "night",
    emoji: "🌃",
    name: "藍調結束",
    heading: "今晚的光已收場",
    tips: [
      "看明天：日落時刻與判定見上方日期切換",
      "剛拍完？回「紀錄」分頁回報 A–D，累積校準資料",
    ],
  },
};

/** 由太陽時間表與現在時刻推導光線相位。
 * @param {{goldenStartMs:number, sunsetMs:number, civilTwilightEndMs:number}} sun
 * @param {number} nowMs
 * @returns {{phase: object, untilMs: number|null, progress: number|null}}
 *   untilMs = 下一個相位邊界；progress = 目前相位進度 0–1（day/night 為 null）。
 */
export function lightPhase(sun, nowMs) {
  const { goldenStartMs: g, sunsetMs: s, civilTwilightEndMs: c } = sun;
  if (nowMs < g) return { phase: PHASES.day, untilMs: g, progress: null };
  if (nowMs < s) return { phase: PHASES.golden, untilMs: s, progress: (nowMs - g) / (s - g) };
  if (nowMs < c) return { phase: PHASES.afterglow, untilMs: c, progress: (nowMs - s) / (c - s) };
  return { phase: PHASES.night, untilMs: null, progress: null };
}

/** mm 分 ss 秒 / h 小時 m 分 的短倒數字串。 */
export function untilStr(untilMs, nowMs) {
  const mins = Math.max(0, Math.round((untilMs - nowMs) / 60000));
  if (mins >= 60) return `${Math.floor(mins / 60)} 小時 ${String(mins % 60).padStart(2, "0")} 分`;
  return `${mins} 分鐘`;
}
