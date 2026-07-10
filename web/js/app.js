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

const DEMO = new URLSearchParams(location.search).has("demo");
const $ = (id) => document.getElementById(id);

/** demo 模式固定「現在 = 今天 16:20 台北」，畫面可重現；正式模式用真實時間。 */
function nowMs() {
  if (!DEMO) return Date.now();
  const [y, m, d] = taipeiDatePlus(0).split("-").map(Number);
  return Date.UTC(y, m - 1, d, 16 - TAIPEI_UTC_OFFSET_H, 20);
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
  lastFetchMs: null,
  weatherStale: false,
  weatherCache: new Map(), // `${dateStr}|${vpId}` → WeatherWindow（工作階段快取）
  cams: null, // data/cams.json（出發前確認連結，人工維護）
};

const vpsInRegion = (region) => state.viewpoints.filter((v) => v.region === region);
const findVp = (id) => state.viewpoints.find((v) => v.id === id);
const availableRegions = () => REGIONS.filter((r) => state.viewpoints.some((v) => v.region === r));

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
  card.innerHTML = `<p class="muted small">取得 Open-Meteo 天氣資料中…（逾時會自動降級）</p>`;
  // 全台各點位置不同，天氣須逐點擷取（同地區點數不多，快取後切換零成本）。
  const active = vpsInRegion(state.region);
  const weathers = await Promise.all(active.map((vp) => getWeather(dateStr, vp, { fresh })));
  state.results = active.map((vp, i) => analyze(dateStr, vp, weathers[i], nowMs()));
  state.recommended = recommend(state.results);
  state.weatherStale = weathers.some((w) => w._stale);
  state.lastFetchMs = Math.max(0, ...weathers.map((w) => w.fetchedAt ?? 0)) || Date.now();
  renderForecast();
  renderDayStrip(); // 選定點位三日概覽
}

// ── 白話摘要（新手可讀，from 主導理由）──────────────────
function plainSummary(result) {
  if (!result.probs) return "拿不到天氣資料，僅顯示太陽時間表。";
  const r = result.probs.reasons.join("");
  if (r.includes("死亡條款")) return "低雲或降雨會全面遮擋，今晚基本上看不到。";
  let s;
  if (r.includes("理想帶")) s = "雲況在理想帶：低雲有縫、中高雲有燃料，值得出門。";
  else if (r.includes("太乾淨")) s = "天空太乾淨，多半只是普通橘色夕陽。";
  else if (r.includes("太厚")) s = "中高雲偏厚，夕陽光不一定穿得透。";
  else s = "雲況中性，照機率決定。";
  if (r.includes("低雲干擾")) s += "但低雲偏多是最大變數。";
  if (r.includes("雨後放晴")) s += "雨後放晴是加分項。";
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
  const cd = `距日落 <b>${Math.floor(mins / 60)} 小時 ${String(mins % 60).padStart(2, "0")} 分</b>`;
  const access = parseAccessMinutes(result.viewpoint.access);
  let dep = "";
  if (access) {
    const leaveBy = result.sun.goldenStartMs - access * 60000;
    dep =
      now <= leaveBy
        ? `建議 <b>${hhmm(leaveBy)}</b> 前出發（路程約 ${access} 分，趕上黃金時段）`
        : `現在出發約 <b>${hhmm(now + access * 60000)}</b> 抵達`;
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
  $("topbar-date").textContent = `${dateLabel(dateStr)} 日落`;

  const main =
    state.results.find((r) => r.viewpoint.id === state.selectedVpId) ??
    state.recommended ??
    state.results[0];
  const card = $("verdict-card");
  card.classList.remove("skeleton");
  $("preliminary-banner").classList.toggle("hidden", !main.preliminary);
  const staleBanner = $("stale-banner");
  if (state.weatherStale) {
    staleBanner.textContent = `⚠️ 離線快取資料（${hhmm(state.lastFetchMs)} 取得），僅供參考`;
    staleBanner.classList.remove("hidden");
  } else staleBanner.classList.add("hidden");
  card.classList.toggle("preliminary", main.preliminary);

  const p = main.probs;
  const hw = main.intervalHalfWidth ?? 10;
  const vClass = main.verdict === VERDICT_GO ? "go" : main.verdict === VERDICT_NO_DATA ? "nodata" : "skip";
  card.innerHTML = `
    <div class="verdict-head">
      <span class="verdict-word ${vClass}">${esc(main.verdict)}</span>
      <span class="verdict-vp">${esc(main.viewpoint.name)}${main.viewpoint.city ? `<span class="muted small">・${esc(main.viewpoint.city)}</span>` : ""}${main.viewpoint.needs_field_verification ? `<span class="draft-badge" title="${esc(main.viewpoint.coord_source || "座標草稿")}">座標待實地確認</span>` : ""}</span>
    </div>
    <p class="plain-summary">${esc(plainSummary(main))}</p>
    ${countdownHtml(main)}
    ${p ? `
    <div class="summary-row">
      <div class="summary-item">
        <div class="summary-label">火燒雲（C+D）${hw > 10 ? `<span class="hw-tag">±${hw.toFixed(0)}</span>` : ""}</div>
        <div class="summary-value">${intervalStr(p.burnLevel, hw)}</div>
        ${rangeBarHtml(p.burnLevel, hw)}
      </div>
      <div class="summary-item">
        <div class="summary-label">看得到日落（B+C+D）</div>
        <div class="summary-value">${intervalStr(p.sunsetVisible, hw)}</div>
        ${rangeBarHtml(p.sunsetVisible, hw)}
      </div>
    </div>` : `
    <div class="row"><button class="btn" id="retry-btn">重試</button></div>
    <p class="footnote" style="margin-top:8px">${esc(main.weather?.error || "取得失敗")}</p>`}
    ${main.viewpoint.weather_exclusion ? `<p class="footnote" style="margin-top:10px">⚠️ ${esc(main.viewpoint.weather_exclusion)}</p>` : ""}
    <div class="row action-row">
      <a class="btn ghost" target="_blank" rel="noopener"
         href="https://www.google.com/maps/search/?api=1&query=${main.viewpoint.lat},${main.viewpoint.lon}">🧭 導航到${esc(main.viewpoint.name)}</a>
      <button class="btn ghost" id="share-btn">📤 分享判定</button>
    </div>
  `;
  card.querySelector("#retry-btn")?.addEventListener("click", () => runAnalysis({ fresh: true }));
  card.querySelector("#share-btn")?.addEventListener("click", async () => {
    const text = `${dateLabel(dateStr)} 日落判定：${main.verdict}・${main.viewpoint.name}${main.viewpoint.city ? `（${main.viewpoint.city}）` : ""}\n` +
      (p ? `火燒雲 ${intervalStr(p.burnLevel, hw)}｜日落 ${hhmm(main.sun.sunsetMs)}\n` : "") +
      location.href;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        $("data-footnote").textContent = "已複製到剪貼簿";
      }
    } catch { /* 使用者取消 */ }
  });

  // 時間軸 + 羅盤（太陽幾何永遠可用）
  const s = main.sun;
  const items = [
    [s.goldenStartMs, "黃金起"],
    ...(main.obstruction.matched ? [[main.effectiveSunsetMs, "有效沒入"]] : []),
    [s.sunsetMs, "日落"],
    [s.civilTwilightEndMs, "藍調終"],
  ];
  $("timeline-card").innerHTML = `
    <h2>太陽時間軸</h2>
    <div class="timeline">
      ${items.map(([ms, label]) => `
        <div class="tl-item ${label === "有效沒入" ? "dim" : ""}">
          <div class="tl-time">${hhmm(ms)}</div><div class="tl-label">${label}</div>
        </div>`).join("")}
    </div>
    <div class="compass-row">
      ${compassSvg(main)}
      <div class="compass-note">
        日落方位 <b>${s.sunsetAzimuthDeg.toFixed(1)}°</b>（橘針）<br>
        橘扇形＝開闊視線 ${main.viewpoint.open_azimuth_range[0]}–${main.viewpoint.open_azimuth_range[1]}°，紅斑＝建檔遮蔽<br>
        ${esc(main.alignment.message)}
      </div>
    </div>
    ${main.obstruction.matched ? `<p class="footnote" style="margin-top:8px">遮蔽：${esc(main.obstruction.note)}（仰角 ${main.obstruction.angleDeg.toFixed(1)}° → 提前 ${main.obstruction.earlyMinutes.toFixed(0)} 分鐘沒入）</p>` : ""}
  `;

  // 情境條 + 說明
  if (p) {
    const seg = (cls, v, letter) =>
      `<i class="${cls}" style="flex:${v.toFixed(2)}" >${v >= 8 ? letter : ""}</i>`;
    $("scenario-card").innerHTML = `
      <h2>四情境機率</h2>
      <div class="stack-bar" role="img" aria-label="A ${intervalStr(p.a)}，B ${intervalStr(p.b)}，C ${intervalStr(p.c)}，D ${intervalStr(p.d)}">
        ${seg("sa", p.a, "A")}${seg("sb", p.b, "B")}${seg("sc", p.c, "C")}${seg("sd", p.d, "D")}
      </div>
      <div class="scenario-legend">
        <span><i class="dot sa"></i>A 擋光 ${intervalStr(p.a, hw)}</span>
        <span><i class="dot sb"></i>B 普通 ${intervalStr(p.b, hw)}</span>
        <span><i class="dot sc"></i>C 局部燒 ${intervalStr(p.c, hw)}</span>
        <span><i class="dot sd"></i>D 全面燒 ${intervalStr(p.d, hw)}</span>
      </div>
      <details class="help">
        <summary>什麼是 A／B／C／D？</summary>
        <ul>
          <li><b>A 擋光</b>：低雲或降雨全面遮擋，什麼都看不到。</li>
          <li><b>B 普通</b>：看得到太陽下山，普通橘色夕陽，無戲劇性。</li>
          <li><b>C 局部燒</b>：部分天空被日落點燃（值得出門的門檻）。</li>
          <li><b>D 全面燒</b>：整片天空燒起來（一年數次等級）。</li>
        </ul>
        <p class="muted">機率一律顯示 ±10 百分點區間——預測本來就有不確定性，單點數字是假精確。</p>
      </details>`;
    const spreadNote =
      main.weather?.modelSpread !== null && main.weather?.modelSpread !== undefined && hw > 10
        ? `<li>多模式雲量分歧 ${main.weather.modelSpread.toFixed(0)}%（${esc(main.weather.ensembleModels)}）→ 區間加寬至 ±${hw.toFixed(0)}</li>`
        : "";
    $("reasons-card").innerHTML = `<h2>理由</h2>
      <ul class="reasons">${p.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}${spreadNote}</ul>`;
    $("scenario-card").classList.remove("hidden");
    $("reasons-card").classList.remove("hidden");
  } else {
    $("scenario-card").classList.add("hidden");
    $("reasons-card").classList.add("hidden");
  }

  // 其他點位
  const others = state.results.filter((r) => r.viewpoint.id !== main.viewpoint.id);
  $("others-card").innerHTML = (others.length ? `<h2>同區其他點位</h2>` : "") + others.map((r) => `
    <button class="other-vp" data-vp="${esc(r.viewpoint.id)}" aria-expanded="${state.expandedVp === r.viewpoint.id}">
      <span>${esc(r.viewpoint.name)}<br><span class="muted small">${esc(r.viewpoint.access || "")}</span></span>
      <span>${r.probs ? `火燒雲 ${intervalStr(r.probs.burnLevel, r.intervalHalfWidth)}` : "資料不足"}・${esc(r.verdict)}</span>
    </button>
    ${state.expandedVp === r.viewpoint.id && r.probs ? `
      <ul class="reasons small" style="padding:0 0 10px">
        <li>日落 ${hhmm(r.sun.sunsetMs)}｜有效沒入 ${hhmm(r.effectiveSunsetMs)}｜藍調至 ${hhmm(r.sun.civilTwilightEndMs)}</li>
        <li>${esc(r.alignment.message)}</li>
        ${r.obstruction.matched ? `<li>遮蔽：${esc(r.obstruction.note)}</li>` : ""}
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
    ? `資料：${main.weather.source}・${hhmm(state.lastFetchMs)} 取得｜評分引擎 ${p.engineVersion}${DEMO ? "｜⚠️ DEMO 模式（擬真資料）" : ""}`
    : "";
}

// ── 出發前 60 秒確認（雷達/衛星/即時影像，人工維護清單）──
const YT_ID_RE = /^[A-Za-z0-9_-]{6,20}$/; // 防注入：只接受合法 id token

function camFacade(c) {
  const id = YT_ID_RE.test(c.youtube_id || "") ? c.youtube_id : "";
  const cid = YT_ID_RE.test(c.channel_id || "") ? c.channel_id : "";
  if (!id && !cid) return "";
  const thumb = id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
  const badge = c.verified === false ? "即時直播・連結待驗證" : "即時直播";
  return `
    <figure class="cam" data-yt="${esc(id)}" data-channel="${esc(cid)}">
      <button class="cam-play" type="button" aria-label="播放 ${esc(c.name)} 即時影像">
        ${thumb ? `<img class="cam-thumb" loading="lazy" src="${thumb}" alt="">` : `<span class="cam-thumb cam-thumb-blank"></span>`}
        <span class="cam-play-icon" aria-hidden="true">▶</span>
        <span class="cam-badge">${esc(badge)}</span>
      </button>
      <figcaption>${esc(c.name)}<br>
        <span class="muted small">${esc(c.looks || "")}</span>
        ${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">在 YouTube 開啟</a>` : ""}
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
    .map((c) => `<a class="btn ghost check-link" target="_blank" rel="noopener" href="${esc(c.url)}">📷 ${esc(c.name)}${c.verified === false ? "（待驗證）" : ""}</a>`)
    .join("");
  card.innerHTML = `
    <h2>出發前 60 秒確認</h2>
    <p class="muted small">預測給機率，眼睛做最後確認——這一步取代「16:30 抬頭看西天」。</p>
    <ol class="reasons small">
      <li>雷達：有無回波正在移入（對流殘留）</li>
      <li>即時影像：西邊天空低雲是否比預報厚</li>
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
  const labels = ["今天", "明天", "後天"];
  const mvp = findVp(state.selectedVpId) ?? vpsInRegion(state.region)[0] ?? state.viewpoints[0];
  if (!mvp) { strip.innerHTML = ""; return; }
  const cells = [];
  for (let off = 0; off < 3; off++) {
    const dateStr = taipeiDatePlus(off);
    const weather = await getWeather(dateStr, mvp); // 快取命中則零成本
    const res = analyze(dateStr, mvp, weather, nowMs());
    cells.push({ off, dateStr, res });
  }
  strip.innerHTML = cells.map(({ off, dateStr, res }) => `
    <button class="day-chip ${state.offset === off ? "active" : ""}" data-offset="${off}"
            aria-pressed="${state.offset === off}">
      <span class="d-label">${labels[off]} ${dateStr.slice(5).replace("-", "/")}</span>
      <span class="d-value">${res?.probs ? `🔥 ${intervalStr(res.probs.burnLevel, res.intervalHalfWidth)}` : "—"}</span>
      <span class="d-verdict ${res?.verdict === VERDICT_GO ? "go" : "skip"}">${res ? esc(res.verdict) : "資料不足"}</span>
    </button>`).join("");
  strip.querySelectorAll(".day-chip").forEach((btn) =>
    btn.addEventListener("click", () => setOffset(Number(btn.dataset.offset))),
  );
}

// ── 地區分頁 + 點位選擇 + 定位找最近 ─────────────────────
function renderRegionBar() {
  const bar = $("region-bar");
  if (!bar) return;
  const tabs = availableRegions()
    .map((r) => `<button class="region-tab ${r === state.region ? "active" : ""}" data-region="${r}" aria-pressed="${r === state.region}">${r}</button>`)
    .join("");
  const chips = vpsInRegion(state.region)
    .map((v) => `<button class="vp-chip ${v.id === state.selectedVpId ? "active" : ""}" data-vp="${esc(v.id)}" aria-pressed="${v.id === state.selectedVpId}">${esc(v.name)}${v.needs_field_verification ? '<span class="draft-dot" title="座標草稿，待實地確認">•</span>' : ""}</button>`)
    .join("");
  bar.innerHTML = `
    <div class="region-row">
      <div class="region-tabs" role="tablist" aria-label="地區">${tabs}</div>
      <button class="btn ghost locate-btn" id="locate-btn" aria-label="用定位找最近的觀景點">📍 最近</button>
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
  // 切地區 → 選定點改為該區第一點（或該區推薦，稍後 runAnalysis 內若無選定會退回推薦）
  state.selectedVpId = vpsInRegion(region)[0]?.id ?? null;
  state.expandedVp = null;
  persistSelection();
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
    $("data-footnote").textContent = "此裝置不支援定位；請用地區分頁手動選";
    return;
  }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "定位中…";
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
        $("data-footnote").textContent = `最近點位：${best.name}（約 ${bestKm.toFixed(0)} km）`;
        runAnalysis();
      }
    },
    () => {
      btn.disabled = false;
      btn.textContent = orig;
      $("data-footnote").textContent = "定位失敗或被拒；請用地區分頁手動選";
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
async function renderLog() {
  const today = taipeiDatePlus(0);
  $("report-title").textContent = `今晚 ${dateLabel(today)} 實際結果？`;
  const { predictions, outcomes, fresh } = await loadLogs();
  const stats = weeklyStats(today, predictions, outcomes);

  const rows = [];
  rows.push(`預測 ${stats.predictedCount}/7 天｜結果回報 ${stats.reportedCount}/7 天`);
  if (stats.goCount)
    rows.push(`判定「出發」${stats.goCount} 天：已回報 ${stats.goReportedCount} 天中實際有燒 ${stats.goBurned} 天`);
  if (stats.skipReportedCount)
    rows.push(`判定「跳過」且有回報 ${stats.skipReportedCount} 天：錯過有燒 ${stats.skipMissed} 天`);
  if (stats.avgCd !== null) rows.push(`預測 C+D 週平均 ${stats.avgCd.toFixed(0)}%`);
  if (stats.burnRate !== null) rows.push(`實際有燒比例 ${stats.burnRate.toFixed(0)}%`);
  rows.push(`<span class="muted">樣本未達 60 天：僅觀察陳述，不做調參。${fresh ? "" : "（⚠️ 離線副本，可能過期）"}</span>`);
  $("weekly-card").innerHTML = `<h2>本週統計</h2><ul class="reasons small">${rows.map((r) => `<li>${r}</li>`).join("")}</ul>`;

  const hist = stats.days.slice().reverse().filter((d) => d.predictedCd !== null || d.outcome);
  $("history-card").innerHTML = `<h2>歷史紀錄（近 7 天）</h2>` + (hist.length ? `
    <table class="history-table">
      <thead><tr><th>日期</th><th>判定</th><th>預測C+D</th><th>實際</th></tr></thead>
      <tbody>${hist.map((d) => `
        <tr>
          <td>${dateLabel(d.date)}</td>
          <td>${esc(d.verdict ?? "—")}</td>
          <td>${d.predictedCd !== null ? intervalStr(d.predictedCd) : "—"}</td>
          <td>${d.outcome ? `<i class="dot s${d.outcome.toLowerCase()}"></i>${d.outcome}${d.reportCount > 1 ? `<span class="muted">（${d.reportCount} 人）</span>` : ""}` : "未回報"}</td>
        </tr>`).join("")}</tbody>
    </table>` : `<p class="muted small">尚無紀錄。</p>`);
}

async function handleReport(outcome) {
  const note = $("report-note").value.trim();
  const status = $("report-status");
  const today = taipeiDatePlus(0);
  if (!getToken()) {
    // 公開回報路徑：預填 Issue Form，登入 GitHub 即可送出，機器人自動記錄
    status.textContent = `已開啟回報表單（${outcome} 已預填）→ 按 Submit 即完成，機器人會自動記錄`;
    window.open(reportIssueUrl(outcome, note), "_blank", "noopener");
    return;
  }
  if (!confirm(`回報 ${today} 實際結果為「${outcome}」？`)) return;
  status.textContent = "送出中…";
  const r = await dispatchReport(outcome, "今天", note);
  status.textContent = r.ok
    ? `✅ 已送出（${outcome}），約 1–2 分鐘後寫入 outcomes.csv`
    : `❌ 送出失敗（HTTP ${r.status}），請檢查 token 權限或改用 GitHub 頁面`;
}

// ── 設定分頁 ─────────────────────────────────────────────
function renderSettings() {
  $("gh-token").value = getToken();
  $("about-text").textContent =
    `評分引擎 ${ENGINE_VERSION}｜規則常數與歷史教訓見 repo docs/。` +
    `太陽幾何為本地計算（NOAA），離線可用。`;
  const items = [
    `Open-Meteo：${state.lastFetchMs ? `最近成功 ${hhmm(state.lastFetchMs)}${state.weatherStale ? "（目前離線快取）" : ""}` : "尚未取得"}`,
    `日誌來源：raw.githubusercontent.com（失敗退回站內副本）`,
    `模式：${DEMO ? "DEMO（擬真資料）" : "正式"}`,
    `天氣資料：<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>（CC BY 4.0）`,
    `<a href="${FEEDBACK_URL}" target="_blank" rel="noopener">💬 回饋與建議（GitHub）</a>`,
  ];
  $("status-list").innerHTML = items.map((i) => `<li>${i}</li>`).join("");
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
  $("save-token").addEventListener("click", () => {
    setToken($("gh-token").value.trim());
    $("token-status").textContent = getToken() ? "已儲存於本機。" : "已清除。";
  });
  $("test-token").addEventListener("click", async () => {
    $("token-status").textContent = "測試中…";
    setToken($("gh-token").value.trim());
    $("token-status").textContent = (await testToken()).message;
  });
}

async function init() {
  bindEvents();
  await loadViewpoints();
  await runAnalysis();
  if ("serviceWorker" in navigator && !DEMO) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
