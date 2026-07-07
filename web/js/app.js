// taipei-sunset PWA 主程式：狀態、渲染、事件。設計規格見 docs/uiux.md、審查見 docs/ux-review.md。

import { analyze, recommend, MAX_QUERY_DAYS_AHEAD, VERDICT_GO, VERDICT_NO_DATA } from "./analysis.js";
import { demoWeather, fetchWeather } from "./weather.js";
import { dateLabel, hhmm, intervalStr, taipeiDatePlus } from "./format.js";
import { ENGINE_VERSION, probInterval } from "./scoring.js";
import { loadLogs, weeklyStats } from "./logs.js";
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

const state = {
  offset: 0, // 0=今天…3
  viewpoints: [],
  results: [],
  recommended: null,
  expandedVp: null,
  lastFetchMs: null,
  weatherStale: false,
  weatherByDate: new Map(), // dateStr → WeatherWindow（工作階段快取）
};

// ── 資料載入 ─────────────────────────────────────────────
async function loadViewpoints() {
  const resp = await fetch("data/viewpoints.json");
  state.viewpoints = await resp.json();
}

const WX_CACHE_KEY = "sunset.last_weather";

async function getWeather(dateStr, lat, lon, { fresh = false } = {}) {
  if (DEMO) return demoWeather(dateStr);
  if (!fresh && state.weatherByDate.has(dateStr)) return state.weatherByDate.get(dateStr);
  const w = await fetchWeather(dateStr, lat, lon);
  if (w.ok) {
    state.weatherByDate.set(dateStr, w);
    try {
      localStorage.setItem(WX_CACHE_KEY, JSON.stringify(w));
    } catch { /* ignore */ }
    state.weatherStale = false;
    return w;
  }
  try {
    const cached = JSON.parse(localStorage.getItem(WX_CACHE_KEY) || "null");
    if (cached && cached.targetDate === dateStr) {
      state.weatherStale = true;
      return cached;
    }
  } catch { /* ignore */ }
  return w;
}

async function runAnalysis({ fresh = false } = {}) {
  const dateStr = taipeiDatePlus(state.offset);
  const card = $("verdict-card");
  card.classList.add("skeleton");
  card.innerHTML = `<p class="muted small">取得 Open-Meteo 天氣資料中…（逾時會自動降級）</p>`;
  const vp0 = state.viewpoints[0];
  // 兩點位同城，取單一天氣（減少 API 呼叫；與 Python 版差異可忽略）
  const weather = await getWeather(dateStr, vp0.lat, vp0.lon, { fresh });
  state.results = state.viewpoints.map((vp) => analyze(dateStr, vp, weather, nowMs()));
  state.recommended = recommend(state.results);
  state.lastFetchMs = weather.fetchedAt ?? Date.now();
  renderForecast();
  renderDayStrip(); // 背景補齊其他日期
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

function rangeBarHtml(point) {
  const [lo, hi] = probInterval(point);
  return `<div class="range-bar" role="img" aria-label="區間 ${lo} 至 ${hi}%">
    <i style="left:${lo}%;width:${hi - lo}%"></i></div>`;
}

function renderForecast() {
  const dateStr = taipeiDatePlus(state.offset);
  $("topbar-date").textContent = `${dateLabel(dateStr)} 日落`;

  const main = state.recommended ?? state.results[0];
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
  const vClass = main.verdict === VERDICT_GO ? "go" : main.verdict === VERDICT_NO_DATA ? "nodata" : "skip";
  card.innerHTML = `
    <div class="verdict-head">
      <span class="verdict-word ${vClass}">${esc(main.verdict)}</span>
      <span class="verdict-vp">推薦：${esc(main.viewpoint.name)}</span>
    </div>
    <p class="plain-summary">${esc(plainSummary(main))}</p>
    ${countdownHtml(main)}
    ${p ? `
    <div class="summary-row">
      <div class="summary-item">
        <div class="summary-label">火燒雲（C+D）</div>
        <div class="summary-value">${intervalStr(p.burnLevel)}</div>
        ${rangeBarHtml(p.burnLevel)}
      </div>
      <div class="summary-item">
        <div class="summary-label">看得到日落（B+C+D）</div>
        <div class="summary-value">${intervalStr(p.sunsetVisible)}</div>
        ${rangeBarHtml(p.sunsetVisible)}
      </div>
    </div>` : `
    <div class="row"><button class="btn" id="retry-btn">重試</button></div>
    <p class="footnote" style="margin-top:8px">${esc(main.weather?.error || "取得失敗")}</p>`}
    ${main.viewpoint.weather_exclusion ? `<p class="footnote" style="margin-top:10px">⚠️ ${esc(main.viewpoint.weather_exclusion)}</p>` : ""}
  `;
  card.querySelector("#retry-btn")?.addEventListener("click", () => runAnalysis({ fresh: true }));

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
        <span><i class="dot sa"></i>A 擋光 ${intervalStr(p.a)}</span>
        <span><i class="dot sb"></i>B 普通 ${intervalStr(p.b)}</span>
        <span><i class="dot sc"></i>C 局部燒 ${intervalStr(p.c)}</span>
        <span><i class="dot sd"></i>D 全面燒 ${intervalStr(p.d)}</span>
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
    $("reasons-card").innerHTML = `<h2>理由</h2>
      <ul class="reasons">${p.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
    $("scenario-card").classList.remove("hidden");
    $("reasons-card").classList.remove("hidden");
  } else {
    $("scenario-card").classList.add("hidden");
    $("reasons-card").classList.add("hidden");
  }

  // 其他點位
  const others = state.results.filter((r) => r.viewpoint.id !== main.viewpoint.id);
  $("others-card").innerHTML = `<h2>其他點位</h2>` + others.map((r) => `
    <button class="other-vp" data-vp="${esc(r.viewpoint.id)}" aria-expanded="${state.expandedVp === r.viewpoint.id}">
      <span>${esc(r.viewpoint.name)}<br><span class="muted small">${esc(r.viewpoint.access || "")}</span></span>
      <span>${r.probs ? `火燒雲 ${intervalStr(r.probs.burnLevel)}` : "資料不足"}・${esc(r.verdict)}</span>
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

  $("data-footnote").textContent = p
    ? `資料：${main.weather.source}・${hhmm(state.lastFetchMs)} 取得｜評分引擎 ${p.engineVersion}${DEMO ? "｜⚠️ DEMO 模式（擬真資料）" : ""}`
    : "";
}

// ── 三日概覽條（點擊切換日期）────────────────────────────
async function renderDayStrip() {
  const strip = $("day-strip");
  const labels = ["今天", "明天", "後天"];
  const vp0 = state.viewpoints[0];
  const cells = [];
  for (let off = 0; off < 3; off++) {
    const dateStr = taipeiDatePlus(off);
    const weather = await getWeather(dateStr, vp0.lat, vp0.lon); // 快取命中則零成本
    const results = state.viewpoints.map((vp) => analyze(dateStr, vp, weather, nowMs()));
    const best = recommend(results);
    cells.push({ off, dateStr, best });
  }
  strip.innerHTML = cells.map(({ off, dateStr, best }) => `
    <button class="day-chip ${state.offset === off ? "active" : ""}" data-offset="${off}"
            aria-pressed="${state.offset === off}">
      <span class="d-label">${labels[off]} ${dateStr.slice(5).replace("-", "/")}</span>
      <span class="d-value">${best?.probs ? `🔥 ${intervalStr(best.probs.burnLevel)}` : "—"}</span>
      <span class="d-verdict ${best?.verdict === VERDICT_GO ? "go" : "skip"}">${best ? esc(best.verdict) : "資料不足"}</span>
    </button>`).join("");
  strip.querySelectorAll(".day-chip").forEach((btn) =>
    btn.addEventListener("click", () => setOffset(Number(btn.dataset.offset))),
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
