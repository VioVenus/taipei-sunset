// taipei-sunset PWA 主程式：狀態、渲染、事件。設計規格見 docs/uiux.md、審查見 docs/ux-review.md。

import { analyze, recommend, MAX_QUERY_DAYS_AHEAD, VERDICT_GO, VERDICT_NO_DATA } from "./analysis.js";
import { demoWeather, fetchWeather } from "./weather.js";
import { dateLabel, hhmm, intervalStr, taipeiDatePlus } from "./format.js";
import { ENGINE_VERSION, probInterval } from "./scoring.js";
import { loadLogs, weeklyStats } from "./logs.js";
import { distanceKm } from "./geometry.js";
import {
  dispatchReport,
  FEEDBACK_URL,
  getToken,
  reportIssueUrl,
  setToken,
  testToken,
} from "./github.js";
import { TAIPEI_UTC_OFFSET_H } from "./solar.js";
import { lightPhase, minutesUntil, PHASE_EMOJI } from "./light.js";
import { applyStatic, getLang, LANGS, setLang, t } from "./i18n.js";

const QS = new URLSearchParams(location.search);
const DEMO = QS.has("demo");
const $ = (id) => document.getElementById(id);

/** demo 模式固定「現在 = 今天 16:20 台北」（可用 ?t=HH:MM 覆寫，供展示各光線相位）；
    正式模式用真實時間。 */
function nowMs() {
  if (!DEMO) return Date.now();
  const [y, m, d] = taipeiDatePlus(0).split("-").map(Number);
  const t = /^(\d{1,2}):(\d{2})$/.exec(QS.get("t") || "");
  const [hh, mm] = t ? [Number(t[1]), Number(t[2])] : [16, 20];
  return Date.UTC(y, m - 1, d, hh - TAIPEI_UTC_OFFSET_H, mm);
}

const REGIONS = ["北", "中", "南", "東", "離島"]; // 顯示順序
const SEL_REGION_KEY = "sunset.region";
const SEL_VP_KEY = "sunset.vp";

const state = {
  offset: 0, // 0=今天…3
  viewpoints: [],
  region: null, // 選定地區（北/中/南/東/離島）
  selectedVpId: null, // 選定點位
  results: [], // 目前地區各點位分析
  recommended: null,
  expandedVp: null,
  reportDay: 0, // 回報哪一天：0=今天、1=昨天（跨午夜補報）
  lastFetchMs: null,
  weatherStale: false,
  weatherCache: new Map(), // `${dateStr}|${vpId}` → WeatherWindow（工作階段快取）
  cams: null, // data/cams.json（出發前確認連結，人工維護）
};

const vpsInRegion = (region) => state.viewpoints.filter((v) => v.region === region);
const findVp = (id) => state.viewpoints.find((v) => v.id === id);
const availableRegions = () => REGIONS.filter((r) => state.viewpoints.some((v) => v.region === r));

// 判定值（出發/跳過/資料不足）是引擎與日誌的內部常數（中文 canonical），
// 只在「顯示」時翻譯——比較邏輯永遠用常數本身。
function verdictLabel(verdict) {
  if (verdict === VERDICT_GO) return t("verdict.go");
  if (verdict === VERDICT_NO_DATA) return t("verdict.nodata");
  return t("verdict.skip");
}

// ── 資料載入 ─────────────────────────────────────────────
async function loadViewpoints() {
  const resp = await fetch("data/viewpoints.json");
  state.viewpoints = await resp.json();
  // 還原上次選擇；驗證仍存在，否則預設第一個可用地區的第一點
  const savedVp = findVp(localStorage.getItem(SEL_VP_KEY) || "");
  const savedRegion = localStorage.getItem(SEL_REGION_KEY);
  if (savedVp) {
    state.selectedVpId = savedVp.id;
    state.region = savedVp.region;
  } else {
    state.region = availableRegions().includes(savedRegion) ? savedRegion : availableRegions()[0];
    state.selectedVpId = vpsInRegion(state.region)[0]?.id ?? null;
  }
}

function persistSelection() {
  try {
    localStorage.setItem(SEL_REGION_KEY, state.region);
    localStorage.setItem(SEL_VP_KEY, state.selectedVpId);
  } catch { /* ignore */ }
}

const WX_CACHE_PREFIX = "sunset.wx."; // 每點各自離線快取（全台各點位置不同）

async function getWeather(dateStr, vp, { fresh = false } = {}) {
  if (DEMO) return demoWeather(dateStr);
  const key = `${dateStr}|${vp.id}`;
  if (!fresh && state.weatherCache.has(key)) return state.weatherCache.get(key);
  const w = await fetchWeather(dateStr, vp.lat, vp.lon);
  if (w.ok) {
    state.weatherCache.set(key, w);
    try {
      localStorage.setItem(WX_CACHE_PREFIX + key, JSON.stringify(w));
    } catch { /* ignore */ }
    return w;
  }
  try {
    const cached = JSON.parse(localStorage.getItem(WX_CACHE_PREFIX + key) || "null");
    if (cached && cached.targetDate === dateStr) return { ...cached, _stale: true };
  } catch { /* ignore */ }
  return w;
}

async function runAnalysis({ fresh = false } = {}) {
  const dateStr = taipeiDatePlus(state.offset);
  renderRegionBar();
  const card = $("verdict-card");
  card.classList.add("skeleton");
  card.innerHTML = `<p class="muted small">${esc(t("common.loading"))}</p>`;
  // 全台各點位置不同，天氣須逐點擷取（同地區點數不多，快取後切換零成本）。
  const active = vpsInRegion(state.region);
  const weathers = await Promise.all(active.map((vp) => getWeather(dateStr, vp, { fresh })));
  state.results = active.map((vp, i) => analyze(dateStr, vp, weathers[i], nowMs()));
  state.recommended = recommend(state.results);
  // 未選點或選點不在本區 → 預設為本區最佳（推薦），而非任意第一點
  const activeIds = new Set(active.map((v) => v.id));
  if (!state.selectedVpId || !activeIds.has(state.selectedVpId)) {
    state.selectedVpId = state.recommended?.viewpoint.id ?? active[0]?.id ?? null;
    persistSelection();
  }
  state.weatherStale = weathers.some((w) => w._stale);
  state.lastFetchMs = Math.max(0, ...weathers.map((w) => w.fetchedAt ?? 0)) || Date.now();
  renderRegionBar(); // 重繪以標示「本區最佳」與選定狀態
  renderForecast();
  renderDayStrip(); // 選定點位三日概覽
}

// ── 白話摘要（新手可讀，from 主導理由）──────────────────
function plainSummary(result) {
  if (!result.probs) return t("summary.noData");
  // 引擎理由字串是中文 canonical——這裡只做關鍵詞判斷選 i18n 句，不翻譯理由本身
  const r = result.probs.reasons.join("");
  if (r.includes("死亡條款")) return t("summary.death");
  const go = result.verdict === VERDICT_GO; // 行動建議跟著判定走，不與「跳過」自相矛盾
  let s;
  if (r.includes("理想帶")) s = go ? t("summary.idealGo") : t("summary.ideal");
  else if (r.includes("太乾淨")) s = t("summary.tooClean");
  else if (r.includes("太厚")) s = t("summary.tooThick");
  else s = go ? t("summary.neutralGo") : t("summary.neutralSkip");
  // 日輪遮蔽（教訓 6）：有此理由時，用更具體的「看不到太陽但天空仍有色彩」取代泛用的低雲提醒
  if (r.includes("太陽本身")) s += t("summary.diskBlock");
  else if (r.includes("低雲干擾")) s += t("summary.lowCloud");
  if (r.includes("雨後放晴")) s += t("summary.rainClear");
  return s;
}

// ── 倒數與建議出發（僅今天、日落前顯示）─────────────────
function parseAccessMinutes(access) {
  const m = /(\d+)(?:\s*[-–~]\s*(\d+))?\s*分/.exec(access || "");
  if (!m) return null;
  return Number(m[2] || m[1]);
}

function countdownHtml(result) {
  if (state.offset !== 0) return "";
  const now = nowMs();
  if (now >= result.sun.sunsetMs) return "";
  const mins = Math.round((result.sun.sunsetMs - now) / 60000);
  const cd = t("countdown.toSunset", { h: Math.floor(mins / 60), m: String(mins % 60).padStart(2, "0") });
  // 出發建議只在判定「出發」時給——跳過日還叫人幾點出門是自相矛盾
  let dep = "";
  if (result.verdict === VERDICT_GO) {
    const access = parseAccessMinutes(result.viewpoint.access);
    if (access) {
      const leaveBy = result.sun.goldenStartMs - access * 60000;
      dep =
        now <= leaveBy
          ? t("countdown.leaveBy", { time: hhmm(leaveBy), mins: access })
          : t("countdown.arriveAt", { time: hhmm(now + access * 60000) });
    }
  }
  return `<div class="countdown-row"><span>${cd}</span>${dep ? `<span>${dep}</span>` : ""}</div>`;
}

// ── 方位羅盤（開闊視線扇形 + 遮蔽 + 日落方位針）─────────
function polar(cx, cy, r, azDeg) {
  const rad = ((azDeg - 90) * Math.PI) / 180; // 北=0 順時針 → SVG 座標
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx, cy, r, a1, a2) {
  const [x1, y1] = polar(cx, cy, r, a1);
  const [x2, y2] = polar(cx, cy, r, a2);
  const large = ((a2 - a1 + 360) % 360) > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`;
}

function compassSvg(result) {
  const c = 44;
  const r = 38;
  const vp = result.viewpoint;
  const az = result.sun.sunsetAzimuthDeg;
  const [nx, ny] = polar(c, c, r + 2, 0);
  const [wx, wy] = polar(c, c, r + 2, 270);
  const [sx, sy] = polar(c, c, r - 6, az);
  const obstructions = (vp.horizon_obstruction || [])
    .map((o) => `<path d="${arcPath(c, c, r, o.azimuth_range[0], o.azimuth_range[1])}" fill="var(--cd)" opacity="0.35"/>`)
    .join("");
  return `
  <svg width="88" height="88" viewBox="0 0 88 88" role="img"
       aria-label="開闊視線 ${vp.open_azimuth_range[0]}–${vp.open_azimuth_range[1]}度，日落方位 ${az.toFixed(0)}度">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--border)" stroke-width="2"/>
    <path d="${arcPath(c, c, r, vp.open_azimuth_range[0], vp.open_azimuth_range[1])}" fill="var(--accent)" opacity="0.25"/>
    ${obstructions}
    <line x1="${c}" y1="${c}" x2="${sx.toFixed(1)}" y2="${sy.toFixed(1)}" stroke="var(--go)" stroke-width="3" stroke-linecap="round"/>
    <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="4" fill="var(--go)"/>
    <text x="${nx.toFixed(1)}" y="${(ny + 3).toFixed(1)}" font-size="9" fill="var(--muted)" text-anchor="middle">N</text>
    <text x="${(wx - 1).toFixed(1)}" y="${(wy + 3).toFixed(1)}" font-size="9" fill="var(--muted)" text-anchor="middle">W</text>
  </svg>`;
}

// ── 預報渲染 ─────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function rangeBarHtml(point, halfWidth) {
  const [lo, hi] = probInterval(point, halfWidth);
  return `<div class="range-bar" role="img" aria-label="區間 ${lo} 至 ${hi}%">
    <i style="left:${lo}%;width:${hi - lo}%"></i></div>`;
}

function renderForecast() {
  const dateStr = taipeiDatePlus(state.offset);
  $("topbar-date").textContent = `${dateLabel(dateStr)} ${t("sunsetWord")}`;

  const main =
    state.results.find((r) => r.viewpoint.id === state.selectedVpId) ??
    state.recommended ??
    state.results[0];
  const card = $("verdict-card");
  card.classList.remove("skeleton");
  $("preliminary-banner").classList.toggle("hidden", !main.preliminary);
  const staleBanner = $("stale-banner");
  if (state.weatherStale) {
    staleBanner.textContent = t("banner.stale", { time: hhmm(state.lastFetchMs) });
    staleBanner.classList.remove("hidden");
  } else staleBanner.classList.add("hidden");
  card.classList.toggle("preliminary", main.preliminary);

  const p = main.probs;
  const hw = main.intervalHalfWidth ?? 10;
  const vClass = main.verdict === VERDICT_GO ? "go" : main.verdict === VERDICT_NO_DATA ? "nodata" : "skip";
  // 判定的主詞是「這個點位」；跳過日不再用「推薦」字眼，明確標示是哪個點、以及是否為本區最佳
  const vpName = esc(main.viewpoint.name);
  const vpCity = main.viewpoint.city ? `<span class="muted small">・${esc(main.viewpoint.city)}</span>` : "";
  const isRegionBest = state.recommended && main.viewpoint.id === state.recommended.viewpoint.id;
  let vpLine;
  if (main.verdict === VERDICT_GO) {
    vpLine = `${esc(t("vp.recommend", { name: main.viewpoint.name }))}${vpCity}`;
  } else if (main.verdict === VERDICT_NO_DATA) {
    vpLine = `${vpName}${vpCity}`;
  } else {
    vpLine = `${vpName}${vpCity}<span class="vp-note">${esc(t(isRegionBest ? "vp.notIdealRegion" : "vp.notIdealHere"))}</span>`;
  }
  card.innerHTML = `
    <div class="verdict-head">
      <span class="verdict-word ${vClass}">${esc(verdictLabel(main.verdict))}</span>
      <span class="verdict-vp">${vpLine}</span>
    </div>
    <p class="plain-summary">${esc(plainSummary(main))}</p>
    ${countdownHtml(main)}
    ${p ? `
    <div class="summary-row">
      <div class="summary-item">
        <div class="summary-label">${esc(t("labels.burn"))}${hw > 10 ? `<span class="hw-tag">±${hw.toFixed(0)}</span>` : ""}</div>
        <div class="summary-value">${intervalStr(p.burnLevel, hw)}</div>
        ${rangeBarHtml(p.burnLevel, hw)}
      </div>
      <div class="summary-item">
        <div class="summary-label">${esc(t("labels.visible"))}</div>
        <div class="summary-value">${intervalStr(p.sunsetVisible, hw)}</div>
        ${rangeBarHtml(p.sunsetVisible, hw)}
      </div>
    </div>` : `
    <div class="row"><button class="btn" id="retry-btn">${esc(t("labels.retry"))}</button></div>
    <p class="footnote" style="margin-top:8px">${esc(main.weather?.error || t("labels.fetchFail"))}</p>`}
    ${main.viewpoint.weather_exclusion ? `<p class="footnote" style="margin-top:10px">⚠️ ${esc(main.viewpoint.weather_exclusion)}</p>` : ""}
    <div class="row action-row">
      <a class="btn ghost" target="_blank" rel="noopener"
         href="https://www.google.com/maps/search/?api=1&query=${main.viewpoint.lat},${main.viewpoint.lon}">${esc(t("actions.navigate", { name: main.viewpoint.name }))}</a>
      <button class="btn ghost" id="share-btn">${esc(t("actions.share"))}</button>
    </div>
  `;
  card.querySelector("#retry-btn")?.addEventListener("click", () => runAnalysis({ fresh: true }));
  card.querySelector("#share-btn")?.addEventListener("click", async () => {
    const nameCity = main.viewpoint.city ? `${main.viewpoint.name}（${main.viewpoint.city}）` : main.viewpoint.name;
    const text = t("share.line1", { date: dateLabel(dateStr), verdict: verdictLabel(main.verdict), name: nameCity }) + "\n" +
      (p ? t("share.line2", { interval: intervalStr(p.burnLevel, hw), time: hhmm(main.sun.sunsetMs) }) + "\n" : "") +
      location.href;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        $("data-footnote").textContent = t("actions.copied");
      }
    } catch { /* 使用者取消 */ }
  });

  renderLightCard(main);

  // 時間軸 + 羅盤（太陽幾何永遠可用）
  const s = main.sun;
  const items = [
    [s.goldenStartMs, t("timeline.golden"), false],
    ...(main.obstruction.matched ? [[main.effectiveSunsetMs, t("timeline.effective"), true]] : []),
    [s.sunsetMs, t("timeline.sunset"), false],
    [s.civilTwilightEndMs, t("timeline.blueEnd"), false],
  ];
  $("timeline-card").innerHTML = `
    <h2>${esc(t("timeline.title"))}</h2>
    <div class="timeline">
      ${items.map(([ms, label, dim]) => `
        <div class="tl-item ${dim ? "dim" : ""}">
          <div class="tl-time">${hhmm(ms)}</div><div class="tl-label">${esc(label)}</div>
        </div>`).join("")}
    </div>
    <div class="compass-row">
      ${compassSvg(main)}
      <div class="compass-note">
        ${t("timeline.azimuth", { az: s.sunsetAzimuthDeg.toFixed(1) })}<br>
        ${esc(t("timeline.sector", { a: main.viewpoint.open_azimuth_range[0], b: main.viewpoint.open_azimuth_range[1] }))}<br>
        ${esc(main.alignment.message)}
      </div>
    </div>
    ${main.obstruction.matched ? `<p class="footnote" style="margin-top:8px">${esc(t("timeline.obstruction", { note: main.obstruction.note, deg: main.obstruction.angleDeg.toFixed(1), mins: main.obstruction.earlyMinutes.toFixed(0) }))}</p>` : ""}
  `;

  // 情境條 + 說明
  if (p) {
    const seg = (cls, v, letter) =>
      `<i class="${cls}" style="flex:${v.toFixed(2)}" >${v >= 8 ? letter : ""}</i>`;
    // 引擎理由是中文 canonical：非中文介面收合為「中文明細」，摘要已在上方 i18n 化
    const zhReasons = `<ul class="reasons">${p.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
    const spreadNote =
      main.weather?.modelSpread !== null && main.weather?.modelSpread !== undefined && hw > 10
        ? `<li>${esc(t("scenario.spreadNote", { spread: main.weather.modelSpread.toFixed(0), models: main.weather.ensembleModels, hw: hw.toFixed(0) }))}</li>`
        : "";
    $("scenario-card").innerHTML = `
      <h2>${esc(t("scenario.title"))}</h2>
      <div class="stack-bar" role="img" aria-label="A ${intervalStr(p.a)}, B ${intervalStr(p.b)}, C ${intervalStr(p.c)}, D ${intervalStr(p.d)}">
        ${seg("sa", p.a, "A")}${seg("sb", p.b, "B")}${seg("sc", p.c, "C")}${seg("sd", p.d, "D")}
      </div>
      <div class="scenario-legend">
        <span><i class="dot sa"></i>${esc(t("scenario.a"))} ${intervalStr(p.a, hw)}</span>
        <span><i class="dot sb"></i>${esc(t("scenario.b"))} ${intervalStr(p.b, hw)}</span>
        <span><i class="dot sc"></i>${esc(t("scenario.c"))} ${intervalStr(p.c, hw)}</span>
        <span><i class="dot sd"></i>${esc(t("scenario.d"))} ${intervalStr(p.d, hw)}</span>
      </div>
      <details class="help">
        <summary>${esc(t("scenario.helpTitle"))}</summary>
        <ul>
          <li>${t("scenario.helpA")}</li>
          <li>${t("scenario.helpB")}</li>
          <li>${t("scenario.helpC")}</li>
          <li>${t("scenario.helpD")}</li>
        </ul>
        <p class="muted">💡 ${esc(t("scenario.helpDisk"))}</p>
        <p class="muted">${esc(t("scenario.interval"))}</p>
      </details>`;
    $("reasons-card").innerHTML = `<h2>${esc(t("scenario.reasonsTitle"))}</h2>` +
      (getLang() === "zh"
        ? `<ul class="reasons">${p.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}${spreadNote}</ul>`
        : `${spreadNote ? `<ul class="reasons">${spreadNote}</ul>` : ""}
           <details class="help"><summary>${esc(t("scenario.reasonsZhNote"))}</summary>${zhReasons}</details>`);
    $("scenario-card").classList.remove("hidden");
    $("reasons-card").classList.remove("hidden");
  } else {
    $("scenario-card").classList.add("hidden");
    $("reasons-card").classList.add("hidden");
  }

  // 其他點位
  const others = state.results.filter((r) => r.viewpoint.id !== main.viewpoint.id);
  $("others-card").innerHTML = (others.length ? `<h2>${esc(t("others.title"))}</h2>` : "") + others.map((r) => `
    <button class="other-vp" data-vp="${esc(r.viewpoint.id)}" aria-expanded="${state.expandedVp === r.viewpoint.id}">
      <span>${esc(r.viewpoint.name)}<br><span class="muted small">${esc(r.viewpoint.access || "")}</span></span>
      <span>${r.probs ? esc(t("others.burnShort", { interval: intervalStr(r.probs.burnLevel, r.intervalHalfWidth) })) : esc(t("others.nodata"))}・${esc(verdictLabel(r.verdict))}</span>
    </button>
    ${state.expandedVp === r.viewpoint.id && r.probs ? `
      <ul class="reasons small" style="padding:0 0 10px">
        <li>${esc(t("timeline.sunset"))} ${hhmm(r.sun.sunsetMs)}｜${esc(t("timeline.effective"))} ${hhmm(r.effectiveSunsetMs)}｜${esc(t("timeline.blueEnd"))} ${hhmm(r.sun.civilTwilightEndMs)}</li>
        <li>${esc(r.alignment.message)}</li>
        ${r.obstruction.matched ? `<li>${esc(r.obstruction.note)}</li>` : ""}
      </ul>` : ""}
  `).join("");
  $("others-card").querySelectorAll(".other-vp").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.expandedVp = state.expandedVp === btn.dataset.vp ? null : btn.dataset.vp;
      renderForecast();
    }),
  );

  renderChecklist(main);

  $("data-footnote").textContent = p
    ? t("common.dataLine", { src: main.weather.source, time: hhmm(state.lastFetchMs), ver: p.engineVersion }) + (DEMO ? t("common.demoTag") : "")
    : "";
}

// ── 現在的光（僅今天）：光線相位 + 對應行動/拍攝建議 ─────
function renderLightCard(main) {
  const card = $("light-card");
  if (!card) return;
  if (state.offset !== 0) {
    card.classList.add("hidden");
    return;
  }
  const now = nowMs();
  const { key, untilMs, progress } = lightPhase(main.sun, now);
  // 餘燼窗口是本卡存在的理由：正在燒的機率高峰，最怕使用者日落一到就走
  const hot = key === "afterglow";
  const mins = untilMs ? minutesUntil(untilMs, now) : 0;
  const dur = mins >= 60
    ? t("common.hm", { h: Math.floor(mins / 60), m: String(mins % 60).padStart(2, "0") })
    : t("common.m", { m: mins });
  card.classList.remove("hidden");
  card.classList.toggle("light-hot", hot);
  card.innerHTML = `
    <div class="light-head">
      <span class="light-emoji" aria-hidden="true">${PHASE_EMOJI[key]}</span>
      <div>
        <div class="light-name">${esc(t("light.now", { name: t(`light.${key}.name`) }))}</div>
        <div class="light-heading ${hot ? "hot" : "muted"}">${esc(t(`light.${key}.heading`))}</div>
      </div>
      ${untilMs ? `<span class="light-until muted small">${esc(t("light.untilNext", { next: t(`light.${key}.next`) }))}<br><b>${esc(dur)}</b></span>` : ""}
    </div>
    ${progress !== null ? `<div class="range-bar light-bar"><i style="left:0;width:${(progress * 100).toFixed(0)}%"></i></div>` : ""}
    <details class="help"${hot ? " open" : ""}>
      <summary>${esc(t("light.tipsTitle"))}</summary>
      <ul>${t(`light.${key}.tips`).map((tip) => `<li>${esc(tip)}</li>`).join("")}</ul>
    </details>`;
}

// ── 出發前 60 秒確認（雷達/衛星/即時影像，人工維護清單）──
const YT_ID_RE = /^[A-Za-z0-9_-]{6,20}$/; // 防注入：只接受合法 id token

function camFacade(c) {
  const id = YT_ID_RE.test(c.youtube_id || "") ? c.youtube_id : "";
  const cid = YT_ID_RE.test(c.channel_id || "") ? c.channel_id : "";
  if (!id && !cid) return "";
  const thumb = id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
  const badge = c.verified === false ? t("checklist.liveUnverified") : t("checklist.live");
  return `
    <figure class="cam" data-yt="${esc(id)}" data-channel="${esc(cid)}">
      <button class="cam-play" type="button" aria-label="${esc(t("checklist.playAria", { name: c.name }))}">
        ${thumb ? `<img class="cam-thumb" loading="lazy" src="${thumb}" alt="">` : `<span class="cam-thumb cam-thumb-blank"></span>`}
        <span class="cam-play-icon" aria-hidden="true">▶</span>
        <span class="cam-badge">${esc(badge)}</span>
      </button>
      <figcaption>${esc(c.name)}<br>
        <span class="muted small">${esc(c.looks || "")}</span>
        ${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(t("checklist.openYt"))}</a>` : ""}
      </figcaption>
    </figure>`;
}

async function renderChecklist(main) {
  const card = $("checklist-card");
  if (!card) return;
  if (!state.cams) {
    try {
      state.cams = await (await fetch("data/cams.json")).json();
    } catch {
      state.cams = { links: [], cams: [] };
    }
  }
  const vpId = main.viewpoint.id;
  const allCams = state.cams.cams || [];
  // 即時直播 facade：僅顯示對應此點位者（避免把北部鏡頭塞給南部使用者）
  const ytCams = allCams.filter((c) => c.type === "youtube" && c.youtube_id && c.viewpoint_id === vpId);
  const facades = ytCams.map(camFacade).join("");
  // 雷達/衛星（全台通用）＋頁面型即時影像（此點位或全域）
  const links = (state.cams.links || [])
    .map((l) => `<a class="btn ghost check-link" target="_blank" rel="noopener" href="${esc(l.url)}">${esc(l.name)}</a>`)
    .join("");
  const pageCams = allCams
    .filter((c) => c.type !== "youtube" && (!c.viewpoint_id || c.viewpoint_id === vpId))
    .map((c) => `<a class="btn ghost check-link" target="_blank" rel="noopener" href="${esc(c.url)}">📷 ${esc(c.name)}${c.verified === false ? esc(t("checklist.unverified")) : ""}</a>`)
    .join("");
  // 跳過日不談「出發」——即時影像變成「不出門也能看」的備案，也能抓預測失誤
  const going = main.verdict === VERDICT_GO;
  // 能見度：低能見度（霧霾）會吃掉色彩層次，是攝影者關心卻常被忽略的變數
  const visKm = main.weather?.visibilityM ? main.weather.visibilityM / 1000 : null;
  const visLine = visKm !== null
    ? `<li>${esc(t("checklist.visibility", { km: visKm.toFixed(0), warn: visKm < 10 ? t("checklist.visibilityWarn") : "" }))}</li>`
    : "";
  card.innerHTML = `
    <h2>${esc(t(going ? "checklist.goTitle" : "checklist.skipTitle"))}</h2>
    <p class="muted small">${esc(t(going ? "checklist.goIntro" : "checklist.skipIntro"))}</p>
    <ol class="reasons small">
      <li>${esc(t("checklist.step1"))}</li>
      <li>${esc(t("checklist.step2"))}</li>
      ${visLine}
    </ol>
    ${facades ? `<div class="cam-grid">${facades}</div>` : ""}
    <div class="row" style="flex-wrap:wrap">${links}${pageCams}</div>`;

  // 點縮圖才載入 iframe（lite facade）：不自動載 3 個 player，離線亦不崩、省流量、隱私友善
  card.querySelectorAll(".cam-play").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fig = btn.closest(".cam");
      const id = fig.dataset.yt;
      const cid = fig.dataset.channel;
      const src = cid
        ? `https://www.youtube-nocookie.com/embed/live_stream?channel=${encodeURIComponent(cid)}&autoplay=1&rel=0&playsinline=1`
        : `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1`;
      const frame = document.createElement("div");
      frame.className = "cam-frame";
      frame.innerHTML = `<iframe src="${src}" title="即時影像" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      btn.replaceWith(frame);
    });
  });
}

// ── 三日概覽條（選定點位跨三日；點擊切換日期）────────────
async function renderDayStrip() {
  const strip = $("day-strip");
  const labels = [t("chips.today"), t("chips.tomorrow"), t("chips.dayAfter")];
  const mvp = findVp(state.selectedVpId) ?? vpsInRegion(state.region)[0] ?? state.viewpoints[0];
  if (!mvp) { strip.innerHTML = ""; return; }
  const cells = [];
  for (let off = 0; off < 3; off++) {
    const dateStr = taipeiDatePlus(off);
    const weather = await getWeather(dateStr, mvp); // 快取命中則零成本
    const res = analyze(dateStr, mvp, weather, nowMs());
    cells.push({ off, dateStr, res });
  }
  // 三日最佳日標 🌟（參考 Alpenglow 的多日展望：把「哪天值得」變成一眼可見）
  const scored = cells.filter((c) => c.res?.probs);
  const best = scored.length
    ? scored.reduce((a, b) => (b.res.probs.burnLevel > a.res.probs.burnLevel ? b : a))
    : null;
  strip.innerHTML = cells.map(({ off, dateStr, res }) => `
    <button class="day-chip ${state.offset === off ? "active" : ""}" data-offset="${off}"
            aria-pressed="${state.offset === off}">
      <span class="d-label">${best && best.off === off && scored.length > 1 ? "🌟 " : ""}${esc(labels[off])} ${dateStr.slice(5).replace("-", "/")}</span>
      <span class="d-value">${res?.probs ? `🔥 ${intervalStr(res.probs.burnLevel, res.intervalHalfWidth)}` : "—"}</span>
      <span class="d-verdict ${res?.verdict === VERDICT_GO ? "go" : "skip"}">${res ? esc(verdictLabel(res.verdict)) : esc(t("verdict.nodata"))}</span>
    </button>`).join("");
  strip.querySelectorAll(".day-chip").forEach((btn) =>
    btn.addEventListener("click", () => setOffset(Number(btn.dataset.offset))),
  );
  // 「明晚更好」導流：今天跳過、明天明顯較佳時，把使用者留在產品循環裡
  const hint = $("better-hint");
  const today = cells[0]?.res;
  const tmrw = cells[1]?.res;
  const better =
    state.offset === 0 &&
    today && today.verdict !== VERDICT_GO && tmrw?.probs &&
    (tmrw.probs.burnLevel - (today.probs?.burnLevel ?? 0)) >= 10;
  if (better) {
    hint.textContent = t("strip.betterHint", { interval: intervalStr(tmrw.probs.burnLevel, tmrw.intervalHalfWidth) });
    hint.classList.remove("hidden");
  } else hint.classList.add("hidden");
}

// ── 地區分頁 + 點位選擇 + 定位找最近 ─────────────────────
function renderRegionBar() {
  const bar = $("region-bar");
  if (!bar) return;
  const tabs = availableRegions()
    .map((r) => `<button class="region-tab ${r === state.region ? "active" : ""}" data-region="${r}" aria-pressed="${r === state.region}">${esc(t(`region.${r}`))}</button>`)
    .join("");
  const bestId = state.recommended?.viewpoint.id;
  const chips = vpsInRegion(state.region)
    .map((v) => {
      const sel = v.id === state.selectedVpId;
      const best = v.id === bestId;
      const mark = best ? '<span class="best-star" title="本區今晚最佳">★</span>' : "";
      return `<button class="vp-chip ${sel ? "active" : ""} ${best ? "best" : ""}" data-vp="${esc(v.id)}" aria-pressed="${sel}">${mark}${esc(v.name)}</button>`;
    })
    .join("");
  bar.innerHTML = `
    <div class="region-row">
      <div class="region-tabs" role="tablist" aria-label="地區">${tabs}</div>
      <button class="btn ghost locate-btn" id="locate-btn">${esc(t("locate.btn"))}</button>
    </div>
    <div class="vp-chips" role="tablist" aria-label="點位">${chips}</div>`;
  bar.querySelectorAll(".region-tab").forEach((btn) =>
    btn.addEventListener("click", () => selectRegion(btn.dataset.region)),
  );
  bar.querySelectorAll(".vp-chip").forEach((btn) =>
    btn.addEventListener("click", () => selectViewpoint(btn.dataset.vp)),
  );
  $("locate-btn").addEventListener("click", locateNearest);
}

function selectRegion(region) {
  if (region === state.region) return;
  state.region = region;
  // 切地區 → 清空選點，runAnalysis 會自動選本區最佳（推薦）
  state.selectedVpId = null;
  state.expandedVp = null;
  runAnalysis();
}

function selectViewpoint(id) {
  if (!findVp(id)) return;
  state.selectedVpId = id;
  persistSelection();
  renderRegionBar();
  renderForecast(); // 天氣多半已快取；未快取的點在 runAnalysis 已抓
  renderDayStrip();
}

function locateNearest() {
  const btn = $("locate-btn");
  if (!navigator.geolocation) {
    $("data-footnote").textContent = t("locate.noGeo");
    return;
  }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = t("locate.ing");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      let best = null;
      let bestKm = Infinity;
      for (const v of state.viewpoints) {
        const d = distanceKm(latitude, longitude, v.lat, v.lon);
        if (d < bestKm) { bestKm = d; best = v; }
      }
      btn.disabled = false;
      btn.textContent = orig;
      if (best) {
        state.region = best.region;
        state.selectedVpId = best.id;
        state.expandedVp = null;
        persistSelection();
        $("data-footnote").textContent = t("locate.found", { name: best.name, km: bestKm.toFixed(0) });
        runAnalysis();
      }
    },
    () => {
      btn.disabled = false;
      btn.textContent = orig;
      $("data-footnote").textContent = t("locate.fail");
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
  );
}

function setOffset(offset) {
  state.offset = offset;
  document.querySelectorAll(".chip").forEach((c) =>
    c.classList.toggle("active", Number(c.dataset.offset) === offset),
  );
  runAnalysis();
}

// ── 紀錄分頁 ─────────────────────────────────────────────
const MY_REPORT_KEY = "sunset.myreport."; // + date → outcome（本機記憶，防重複/顯示已回報）

async function renderLog() {
  const today = taipeiDatePlus(0);
  const backfill = state.reportDay === 1;
  const reportDate = taipeiDatePlus(-state.reportDay); // 0=今天、1=昨天
  // 日期切換高亮
  document.querySelectorAll("#report-day .chip").forEach((c) =>
    c.classList.toggle("active", Number(c.dataset.day) === state.reportDay),
  );
  $("report-title").textContent = t(backfill ? "log.titleBackfill" : "log.title", { date: dateLabel(reportDate) });

  // 回報脈絡：對應日的判定＋預測區間（今天且已載入才有；補報昨天顯示提示）
  const todayRes =
    !backfill && state.offset === 0
      ? (state.results.find((r) => r.viewpoint.id === state.selectedVpId) ?? state.recommended)
      : null;
  const mine = localStorage.getItem(MY_REPORT_KEY + reportDate);
  const ctx = [];
  if (backfill) ctx.push(`<span class="muted">${esc(t("log.backfillHint"))}</span>`);
  if (todayRes?.probs) {
    ctx.push(esc(t("log.context", {
      name: todayRes.viewpoint.name,
      verdict: verdictLabel(todayRes.verdict),
      interval: intervalStr(todayRes.probs.burnLevel, todayRes.intervalHalfWidth),
    })));
  }
  if (mine) ctx.push(t("log.mine", { outcome: esc(mine) }));
  $("report-context").innerHTML = ctx.join("<br>");

  // 立即給 loading 骨架——日誌走網路（4s 逾時＋本地退回），空白卡片像壞掉
  $("weekly-card").innerHTML = `<h2>${esc(t("log.weeklyTitle"))}</h2><p class="muted small">…</p>`;
  $("history-card").innerHTML = `<h2>${esc(t("log.histTitle"))}</h2><p class="muted small">…</p>`;

  const { predictions, outcomes, fresh } = await loadLogs();
  const stats = weeklyStats(today, predictions, outcomes);

  const rows = [];
  rows.push(esc(t("log.wPredicted", { p: stats.predictedCount, r: stats.reportedCount })));
  if (stats.goCount)
    rows.push(esc(t("log.wGo", { n: stats.goCount, rep: stats.goReportedCount, burn: stats.goBurned })));
  if (stats.skipReportedCount)
    rows.push(esc(t("log.wSkip", { n: stats.skipReportedCount, miss: stats.skipMissed })));
  if (stats.avgCd !== null) rows.push(esc(t("log.wAvg", { v: stats.avgCd.toFixed(0) })));
  if (stats.burnRate !== null) rows.push(esc(t("log.wRate", { v: stats.burnRate.toFixed(0) })));
  rows.push(`<span class="muted">${esc(t("log.wSample"))}${fresh ? "" : esc(t("log.wOffline"))}</span>`);
  $("weekly-card").innerHTML = `<h2>${esc(t("log.weeklyTitle"))}</h2><ul class="reasons small">${rows.map((r) => `<li>${r}</li>`).join("")}</ul>`;

  // 方向欄：預測有無過出發門檻（C+D≥25）與實際有無燒（C/D）方向是否一致。
  // 不是嚴格校準（那要 60 天樣本），只是讓人一眼看到對錯趨勢。
  const dir = (d) => {
    if (d.predictedCd === null || !d.outcome) return "—";
    const saidBurn = d.predictedCd >= 25;
    const didBurn = d.outcome === "C" || d.outcome === "D";
    return saidBurn === didBurn ? "✓" : "✗";
  };
  const hist = stats.days.slice().reverse().filter((d) => d.predictedCd !== null || d.outcome);
  $("history-card").innerHTML = `<h2>${esc(t("log.histTitle"))}</h2>` + (hist.length ? `
    <table class="history-table">
      <thead><tr><th>${esc(t("log.thDate"))}</th><th>${esc(t("log.thVerdict"))}</th><th>${esc(t("log.thPred"))}</th><th>${esc(t("log.thActual"))}</th><th title="${esc(t("log.dirTip"))}">${esc(t("log.thDir"))}</th></tr></thead>
      <tbody>${hist.map((d) => `
        <tr>
          <td>${dateLabel(d.date)}</td>
          <td>${d.verdict ? esc(verdictLabel(d.verdict)) : "—"}</td>
          <td>${d.predictedCd !== null ? intervalStr(d.predictedCd) : "—"}</td>
          <td>${d.outcome ? `<i class="dot s${d.outcome.toLowerCase()}"></i>${d.outcome}${d.reportCount > 1 ? `<span class="muted">${esc(t("log.people", { n: d.reportCount }))}</span>` : ""}` : esc(t("log.notReported"))}</td>
          <td class="dir-${dir(d) === "✓" ? "hit" : dir(d) === "✗" ? "miss" : "na"}">${dir(d)}</td>
        </tr>`).join("")}</tbody>
    </table>
    <p class="footnote">${esc(t("log.dirNote"))}</p>`
    : `<p class="muted small">${esc(t("log.empty"))}</p>`);
}

async function handleReport(outcome) {
  const note = $("report-note").value.trim();
  const status = $("report-status");
  // 回報日期跟著切換走：0=今天、1=昨天。ingest 與 workflow 都收「今天|昨天」。
  const reportDate = taipeiDatePlus(-state.reportDay);
  const dateArg = state.reportDay === 1 ? "昨天" : "今天";
  const remember = () => {
    try { localStorage.setItem(MY_REPORT_KEY + reportDate, outcome); } catch { /* ignore */ }
  };
  if (!getToken()) {
    // 公開回報路徑：預填 Issue Form（含日期），登入 GitHub 即可送出，機器人自動記錄
    status.textContent = t("log.openForm", { outcome });
    remember();
    renderLog();
    window.open(reportIssueUrl(outcome, note, dateArg), "_blank", "noopener");
    return;
  }
  if (!confirm(t("log.confirm", { date: reportDate, outcome }))) return;
  status.textContent = t("log.sending");
  const r = await dispatchReport(outcome, dateArg, note);
  if (r.ok) remember();
  status.textContent = r.ok
    ? t("log.sent", { outcome })
    : t("log.sendFail", { status: r.status });
  if (r.ok) renderLog();
}

// ── 設定分頁 ─────────────────────────────────────────────
// 維護者卡預設隱藏：站是公開的，token 介面對一般訪客是雜訊、且不該鼓勵
// 「把 token 貼進網站」。連點版本文字 7 下開啟。注意這是介面整理不是保安——
// 靜態站的任何「密碼」都能看原始碼繞過；真機密只活在 GitHub Secrets。
const MAINT_KEY = "sunset.maint";
let aboutTaps = 0;

function maintOn() {
  return localStorage.getItem(MAINT_KEY) === "1";
}

function renderSettings() {
  $("about-text").textContent = t("settings.aboutText", { ver: ENGINE_VERSION });
  const omStatus = state.lastFetchMs
    ? t("settings.stOk", { time: hhmm(state.lastFetchMs) }) + (state.weatherStale ? t("settings.stStale") : "")
    : t("settings.stNone");
  const items = [
    esc(t("settings.stOpenMeteo", { v: omStatus })),
    esc(t("settings.stLogs")),
    esc(t("settings.stMode", { v: DEMO ? t("settings.stDemo") : t("settings.stProd") })),
    t("settings.stCredit"),
    `<a href="${FEEDBACK_URL}" target="_blank" rel="noopener">${esc(t("settings.stFeedback"))}</a>`,
  ];
  $("status-list").innerHTML = items.map((i) => `<li>${i}</li>`).join("");
  $("maint-card").classList.toggle("hidden", !maintOn());
  if (maintOn()) $("gh-token").value = getToken();
}

// ── 首次使用引導（一次性，可關閉）────────────────────────
const ONBOARD_KEY = "sunset.onboarded";

function renderOnboard() {
  const card = $("onboard-card");
  if (!card) return;
  let seen = false;
  try { seen = localStorage.getItem(ONBOARD_KEY) === "1"; } catch { /* ignore */ }
  if (seen) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  card.innerHTML = `
    <h2>${esc(t("onboard.title"))}</h2>
    <ul class="reasons small">
      <li>${esc(t("onboard.b1"))}</li>
      <li>${esc(t("onboard.b2"))}</li>
      <li>${esc(t("onboard.b3"))}</li>
    </ul>
    <div class="row"><button class="btn" id="onboard-dismiss">${esc(t("onboard.dismiss"))}</button></div>`;
  $("onboard-dismiss").addEventListener("click", () => {
    try { localStorage.setItem(ONBOARD_KEY, "1"); } catch { /* ignore */ }
    card.classList.add("hidden");
  });
}

// ── 事件與初始化 ─────────────────────────────────────────
function bindEvents() {
  $("date-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const offset = Number(chip.dataset.offset);
    if (offset > MAX_QUERY_DAYS_AHEAD) return;
    setOffset(offset);
  });
  $("refresh-btn").addEventListener("click", () => runAnalysis({ fresh: true }));
  document.querySelectorAll(".nav-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab").forEach((t) =>
        t.classList.toggle("active", t.id === `tab-${btn.dataset.tab}`),
      );
      if (btn.dataset.tab === "log") renderLog();
      if (btn.dataset.tab === "settings") renderSettings();
    }),
  );
  document.querySelectorAll(".report-btn").forEach((btn) =>
    btn.addEventListener("click", () => handleReport(btn.dataset.outcome)),
  );
  // 今天／昨天 切換（跨午夜補報）
  $("report-day").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.reportDay = Number(chip.dataset.day);
    $("report-status").textContent = "";
    renderLog();
  });
  $("save-token").addEventListener("click", () => {
    setToken($("gh-token").value.trim());
    $("token-status").textContent = getToken() ? t("settings.saved") : t("settings.clearedTok");
  });
  $("test-token").addEventListener("click", async () => {
    $("token-status").textContent = t("settings.testing");
    setToken($("gh-token").value.trim());
    $("token-status").textContent = (await testToken()).message;
  });
  // 維護者模式開關：連點「關於」版本文字 7 下開啟；離開時清除 token
  $("about-text").addEventListener("click", () => {
    aboutTaps += 1;
    if (aboutTaps >= 7) {
      aboutTaps = 0;
      try { localStorage.setItem(MAINT_KEY, "1"); } catch { /* ignore */ }
      renderSettings();
      $("token-status").textContent = t("settings.maintOn");
    }
  });
  $("exit-maint").addEventListener("click", () => {
    setToken("");
    try { localStorage.removeItem(MAINT_KEY); } catch { /* ignore */ }
    renderSettings();
  });
  // 語言切換：狀態都在 localStorage，重載最不易殘留半翻譯畫面
  const sel = $("lang-select");
  sel.innerHTML = LANGS.map((l) => `<option value="${l.code}" ${l.code === getLang() ? "selected" : ""}>${l.label}</option>`).join("");
  sel.addEventListener("change", () => {
    setLang(sel.value);
    location.reload();
  });
}

async function init() {
  applyStatic(); // 靜態 HTML 依語言翻譯（data-i18n）
  bindEvents();
  renderOnboard();
  await loadViewpoints();
  await runAnalysis();
  if ("serviceWorker" in navigator && !DEMO) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
