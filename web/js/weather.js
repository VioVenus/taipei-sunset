// Open-Meteo 客戶端擷取 —— 聚合邏輯與 src/sunset/weather.py 一致。
// timeout 10s、重試一次、失敗降級為 ok:false（絕不拋到 UI 層）。

export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
export const REQUEST_TIMEOUT_MS = 10000;
export const RETRY_COUNT = 1;

export const WINDOW_HOURS = [17, 18, 19];
export const EVENING_HOURS = [18, 19];
export const RAIN_RECENT_HOURS = [12, 13, 14, 15, 16];
export const RAIN_STOP_HOURS = [17, 18];
export const RAIN_MM_THRESHOLD = 0.1;

const HOURLY_FIELDS = [
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "cloud_cover",
  "visibility",
  "precipitation_probability",
  "precipitation",
];

const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

function insufficient(dateStr, error) {
  return { targetDate: dateStr, source: "open-meteo", ok: false, error, fetchedAt: Date.now() };
}

/** 解析 Open-Meteo hourly payload → 評估窗口彙總（與 Python _parse 對齊）。 */
export function parseOpenMeteo(dateStr, payload) {
  const hourly = payload.hourly;
  // Open-Meteo 回傳台北當地時間字串（timezone=Asia/Taipei）；
  // 直接解析 "YYYY-MM-DDTHH:MM" 的小時欄位，不經 Date（瀏覽器時區無關）。
  const hourIndex = new Map();
  hourly.time.forEach((t, i) => hourIndex.set(parseInt(t.slice(11, 13), 10), i));

  const series = (name, hours) =>
    hours.map((h) => {
      const idx = hourIndex.get(h);
      const v = hourly[name]?.[idx];
      if (v === null || v === undefined) throw new Error(`${name}@${h}:00 缺值`);
      return Number(v);
    });

  const precipRecent = series("precipitation", RAIN_RECENT_HOURS);
  const precipStop = series("precipitation", RAIN_STOP_HOURS);
  const rainRecent =
    precipRecent.some((v) => v > RAIN_MM_THRESHOLD) &&
    precipStop.every((v) => v <= RAIN_MM_THRESHOLD);

  return {
    targetDate: dateStr,
    source: "open-meteo",
    ok: true,
    cloudLow: mean(series("cloud_cover_low", WINDOW_HOURS)),
    cloudMid: mean(series("cloud_cover_mid", WINDOW_HOURS)),
    cloudHigh: mean(series("cloud_cover_high", WINDOW_HOURS)),
    cloudTotal: mean(series("cloud_cover", WINDOW_HOURS)),
    visibilityM: mean(series("visibility", WINDOW_HOURS)),
    precipProbWindow: mean(series("precipitation_probability", WINDOW_HOURS)),
    precipProbEvening: Math.max(...series("precipitation_probability", EVENING_HOURS)),
    precipWindowMm: series("precipitation", WINDOW_HOURS).reduce((s, v) => s + v, 0),
    rainRecentFlag: rainRecent,
    fetchedAt: Date.now(),
  };
}

async function fetchOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 擷取單日評估窗口；失敗回傳 {ok:false, error}。 */
export async function fetchWeather(dateStr, lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: HOURLY_FIELDS.join(","),
    timezone: "Asia/Taipei",
    start_date: dateStr,
    end_date: dateStr,
  });
  const url = `${OPEN_METEO_URL}?${params}`;
  let lastError = "unknown";
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      const payload = await fetchOnce(url);
      try {
        return parseOpenMeteo(dateStr, payload);
      } catch (e) {
        return insufficient(dateStr, `Open-Meteo 回應解析失敗：${e.message}`);
      }
    } catch (e) {
      lastError = e.name === "AbortError" ? "timeout" : e.message;
    }
  }
  return insufficient(dateStr, `Open-Meteo API 失敗：${lastError}`);
}

/** Demo 模式：內建擬真天氣，供展示與無網環境。
    今天固定理想帶＋雨後放晴；其他日期依日期字串決定性變化（讓三日概覽有差異）。 */
export function demoWeather(dateStr) {
  const seed = [...dateStr].reduce((s, c) => s + c.charCodeAt(0), 0);
  const variant = seed % 3;
  const presets = [
    { cloudLow: 18, cloudMid: 35, cloudHigh: 52, precipProbEvening: 20, rainRecentFlag: true },
    { cloudLow: 12, cloudMid: 10, cloudHigh: 22, precipProbEvening: 5, rainRecentFlag: false },
    { cloudLow: 55, cloudMid: 45, cloudHigh: 30, precipProbEvening: 45, rainRecentFlag: false },
  ];
  const p = presets[variant];
  return {
    targetDate: dateStr,
    source: "demo",
    ok: true,
    cloudTotal: Math.max(p.cloudLow, p.cloudMid, p.cloudHigh) + 10,
    visibilityM: 21000,
    precipProbWindow: p.precipProbEvening,
    precipWindowMm: 0,
    fetchedAt: Date.now(),
    ...p,
  };
}
