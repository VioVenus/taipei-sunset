// 日誌讀取：優先抓 raw.githubusercontent（最新），失敗退回站內打包副本（標 stale）。
// 週統計邏輯對齊 src/sunset/review.py（觀察陳述，不調參）。

import { BRANCH, REPO } from "./config.js";

export { BRANCH, REPO };
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/data/logs`;
const LOCAL_BASE = "data/logs";

/** 輕量 CSV 解析（本專案日誌欄位不含換行；note 可能含逗號 → 用引號規則）。 */
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const parseLine = (line) => {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = parseLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = parseLine(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

async function fetchCsv(name) {
  // 先試 raw（cache-bust、4s timeout），再退回站內副本
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(`${RAW_BASE}/${name}?t=${Date.now()}`, {
      cache: "no-store",
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (resp.ok) return { rows: parseCsv(await resp.text()), fresh: true };
    throw new Error(`HTTP ${resp.status}`);
  } catch {
    try {
      const resp = await fetch(`${LOCAL_BASE}/${name}`);
      if (resp.ok) return { rows: parseCsv(await resp.text()), fresh: false };
    } catch { /* 打包副本也沒有 */ }
    return { rows: [], fresh: false };
  }
}

export async function loadLogs() {
  const [pred, out, rep] = await Promise.all([
    fetchCsv("predictions.csv"),
    fetchCsv("outcomes.csv"),
    fetchCsv("reports.csv"),
  ]);
  return {
    predictions: pred.rows,
    // 合併回報池：outcomes.csv 視為 reporter="owner"（與 Python logbook.all_reports 同規則）
    outcomes: [
      ...out.rows.map((r) => ({ ...r, reporter: "owner" })),
      ...rep.rows,
    ],
    fresh: pred.fresh && out.fresh,
  };
}

const BURN = new Set(["C", "D"]);
const OUTCOME_ORDER = ["A", "B", "C", "D"];

/** 該日共識：每位回報者最新一票 → 眾數（平手取較保守）；burned = 燒票過半。 */
function consensus(rows) {
  const latest = new Map(); // reporter → [at, outcome]
  for (const r of rows) {
    if (!OUTCOME_ORDER.includes(r.outcome)) continue;
    const who = r.reporter || "anonymous";
    const at = r.reported_at_utc || "";
    if (!latest.has(who) || at >= latest.get(who)[0]) latest.set(who, [at, r.outcome]);
  }
  const votes = [...latest.values()].map(([, o]) => o);
  if (!votes.length) return { outcome: null, burned: null, count: 0 };
  const burnVotes = votes.filter((v) => BURN.has(v)).length;
  const counts = OUTCOME_ORDER.map((o) => votes.filter((v) => v === o).length);
  const best = Math.max(...counts);
  return {
    outcome: OUTCOME_ORDER[counts.indexOf(best)],
    burned: burnVotes > votes.length - burnVotes,
    count: votes.length,
  };
}

/** 過去 7 天（含 endDateStr）配對：每日最後一次預測 vs 最後一筆回報。 */
export function weeklyStats(endDateStr, predictions, outcomes) {
  const days = [];
  const end = new Date(`${endDateStr}T00:00:00Z`).getTime();
  for (let off = 6; off >= 0; off--) {
    const iso = new Date(end - off * 86400000).toISOString().slice(0, 10);
    const rows = predictions.filter((r) => r.target_date === iso);
    const last = rows.length
      ? rows.reduce((a, b) => (a.predicted_at_utc > b.predicted_at_utc ? a : b))
      : null;
    const c = consensus(outcomes.filter((o) => o.target_date === iso));
    days.push({
      date: iso,
      predictedCd: last ? Number(last.prob_C) + Number(last.prob_D) : null,
      verdict: last ? last.verdict : null,
      outcome: c.outcome,
      burned: c.burned,
      reportCount: c.count,
    });
  }
  const predicted = days.filter((d) => d.predictedCd !== null);
  const reported = days.filter((d) => d.outcome !== null);
  const go = days.filter((d) => d.verdict === "出發");
  const goReported = go.filter((d) => d.burned !== null);
  const skipReported = days.filter((d) => d.verdict && d.verdict !== "出發" && d.burned !== null);
  return {
    days,
    predictedCount: predicted.length,
    reportedCount: reported.length,
    goCount: go.length,
    goReportedCount: goReported.length,
    goBurned: goReported.filter((d) => d.burned).length,
    skipReportedCount: skipReported.length,
    skipMissed: skipReported.filter((d) => d.burned).length,
    avgCd: predicted.length
      ? predicted.reduce((s, d) => s + d.predictedCd, 0) / predicted.length
      : null,
    burnRate: reported.length
      ? (100 * reported.filter((d) => d.burned).length) / reported.length
      : null,
  };
}
