// taipei-sunset PWA 主程式：狀態、渲染、事件。設計規格見 docs/uiux.md。

import { analyze, recommend, MAX_QUERY_DAYS_AHEAD, VERDICT_GO, VERDICT_NO_DATA } from "./analysis.js";
import { demoWeather, fetchWeather } from "./weather.js";
import { dateLabel, hhmm, intervalStr, taipeiDatePlus } from "./format.js";
import { ENGINE_VERSION, probInterval } from "./scoring.js";
import { loadLogs, weeklyStats } from "./logs.js";
import { ACTIONS_URL, dispatchReport, getToken, setToken, testToken } from "./github.js";

const DEMO = new URLSearchParams(location.search).has("demo");
const $ = (id) => document.getElementById(id);

const state = {
  offset: 0, // 0=今天…3
  viewpoints: [],
  results: [],
  recommended: null,
  expandedVp: null,
  lastFetchMs: null,
  weatherStale: false,
};

// ── 資料載入 ─────────────────────────────────────────────
async function loadViewpoints() {
  const resp = await fetch("data/viewpoints.json");
  state.viewpoints = await resp.json();
}

const WX_CACHE_KEY = "sunset.last_weather";

async function getWeather(dateStr, lat, lon) {
  if (DEMO) return demoWeather(dateStr);
  const w = await fetchWeather(dateStr, lat, lon);
  if (w.ok) {
    try {
      localStorage.setItem(WX_CACHE_KEY, JSON.stringify(w));
    } catch { /* ignore */ }
    state.weatherStale = false;
    return w;
  }
  // 降級：同日的最後成功快取（標 stale），否則回傳失敗物件
  try {
    const cached = JSON.parse(localStorage.getItem(WX_CACHE_KEY) || "null");
    if (cached && cached.targetDate === dateStr) {
      state.weatherStale = true;
      return cached;
    }
  } catch { /* ignore */ }
  return w;
}

async function runAnalysis() {
  const dateStr = taipeiDatePlus(state.offset);
  $("verdict-card").classList.add("skeleton");
  const vp0 = state.viewpoints[0];
  // 天氣以第一個點位座標取一次（同城市，與 Python 版差異可忽略；每點位分開打會多打 API）
  const weather = await getWeather(dateStr, vp0.lat, vp0.lon);
  state.results = state.viewpoints.map((vp) => analyze(dateStr, vp, weather));
  state.recommended = recommend(state.results);
  state.lastFetchMs = weather.fetchedAt ?? Date.now();
  renderForecast();
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
  $("topbar-date").textContent = `${dateLabel(dateStr)} 台北日落`;

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
    <p class="muted" style="margin-top:8px">⚠️ 天氣資料不足：${esc(main.weather?.error || "取得失敗")}</p>
    <div class="row"><button class="btn" id="retry-btn">重試</button></div>`}
    ${main.viewpoint.weather_exclusion ? `<p class="footnote" style="margin-top:10px">⚠️ ${esc(main.viewpoint.weather_exclusion)}</p>` : ""}
  `;
  card.querySelector("#retry-btn")?.addEventListener("click", runAnalysis);

  // 時間軸（太陽幾何永遠可用）
  const s = main.sun;
  const items = [
    [s.goldenStartMs, "黃金起"],
    ...(main.obstruction.matched ? [[main.effectiveSunsetMs, `有效沒入`]] : []),
    [s.sunsetMs, "日落"],
    [s.civilTwilightEndMs, "藍調終"],
  ];
  $("timeline-card").innerHTML = `
    <h2>太陽時間軸 <span class="muted small">方位 ${s.sunsetAzimuthDeg.toFixed(1)}°</span></h2>
    <div class="timeline">
      ${items.map(([ms, label], i) => `
        <div class="tl-item ${label === "有效沒入" ? "dim" : ""}">
          <div class="tl-time">${hhmm(ms)}</div><div class="tl-label">${label}</div>
        </div>`).join("")}
    </div>
    ${main.obstruction.matched ? `<p class="footnote" style="margin-top:8px">遮蔽：${esc(main.obstruction.note)}（仰角 ${main.obstruction.angleDeg.toFixed(1)}° → 提前 ${main.obstruction.earlyMinutes.toFixed(0)} 分鐘沒入）</p>` : ""}
    <p class="footnote">${esc(main.alignment.message)}</p>
  `;

  // 情境條
  if (p) {
    const seg = (cls, v, letter) =>
      `<i class="${cls}" style="flex:${v.toFixed(2)}" >${v >= 8 ? letter : ""}</i>`;
    $("scenario-card").innerHTML = `
      <h2>四情境機率</h2>
      <div class="stack-bar" aria-label="A ${intervalStr(p.a)}，B ${intervalStr(p.b)}，C ${intervalStr(p.c)}，D ${intervalStr(p.d)}">
        ${seg("sa", p.a, "A")}${seg("sb", p.b, "B")}${seg("sc", p.c, "C")}${seg("sd", p.d, "D")}
      </div>
      <div class="scenario-legend">
        <span><i class="dot sa"></i>A 擋光 ${intervalStr(p.a)}</span>
        <span><i class="dot sb"></i>B 普通 ${intervalStr(p.b)}</span>
        <span><i class="dot sc"></i>C 局部燒 ${intervalStr(p.c)}</span>
        <span><i class="dot sd"></i>D 全面燒 ${intervalStr(p.d)}</span>
      </div>`;
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
          <td>${d.outcome ? `<i class="dot s${d.outcome.toLowerCase()}"></i>${d.outcome}` : "未回報"}</td>
        </tr>`).join("")}</tbody>
    </table>` : `<p class="muted small">尚無紀錄。</p>`);
}

async function handleReport(outcome) {
  const note = $("report-note").value.trim();
  const status = $("report-status");
  const today = taipeiDatePlus(0);
  if (!getToken()) {
    status.innerHTML = `未設定 token → 請在開啟的 GitHub 頁面按 Run workflow（outcome=${outcome}）`;
    window.open(ACTIONS_URL, "_blank", "noopener");
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
    state.offset = offset;
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
    runAnalysis();
  });
  $("refresh-btn").addEventListener("click", runAnalysis);
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
