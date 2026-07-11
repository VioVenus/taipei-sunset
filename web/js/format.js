// 顯示格式：時間、日期、機率區間（全 app 一律區間，禁止單點假精確）。

import { probInterval } from "./scoring.js";
import { TAIPEI_UTC_OFFSET_H } from "./solar.js";
import { getLang, t } from "./i18n.js";

/** epoch ms → 台北 "HH:MM" */
export function hhmm(ms) {
  const t2 = new Date(ms + TAIPEI_UTC_OFFSET_H * 3600000);
  return `${String(t2.getUTCHours()).padStart(2, "0")}:${String(t2.getUTCMinutes()).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" → zh "7/4（六）"｜en "Fri 7/4"｜es "vie 4/7" */
export function dateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = t("weekdays")[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const lang = getLang();
  if (lang === "en") return `${wd} ${m}/${d}`;
  if (lang === "es") return `${wd} ${d}/${m}`;
  return `${m}/${d}（${wd}）`;
}

/** 點估 → "30–50%"（half width 可依模式分歧加寬） */
export function intervalStr(point, halfWidth) {
  const [lo, hi] = probInterval(point, halfWidth);
  return `${lo}–${hi}%`;
}

/** 台北今天 + offset 天 → "YYYY-MM-DD" */
export function taipeiDatePlus(offsetDays, nowMs = Date.now()) {
  const t = new Date(nowMs + TAIPEI_UTC_OFFSET_H * 3600000 + offsetDays * 86400000);
  return t.toISOString().slice(0, 10);
}
