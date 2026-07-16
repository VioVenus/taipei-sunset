// GitHub 一鍵回報：以 fine-grained PAT 呼叫 workflow_dispatch（api.github.com 支援 CORS）。
// Token 只存 localStorage，絕不進任何遠端（除了 GitHub API 本身的 Authorization header）。

import { BRANCH, RELAY_URL, REPO } from "./config.js";

const TOKEN_KEY = "sunset.gh_token";
const REPORTER_KEY = "sunset.reporter_id";
export const ACTIONS_URL = `https://github.com/${REPO}/actions/workflows/on_demand_report.yml`;
export const FEEDBACK_URL = `https://github.com/${REPO}/issues/new?template=feedback.yml`;

/** 中繼是否啟用（config 填了 RELAY_URL 才啟用免帳號免跳轉）。 */
export const relayEnabled = () => Boolean(RELAY_URL);

/** 每台裝置一個穩定隨機匿名 ID（讓「同裝置同日只採計最新」與多數決可運作；可清除）。 */
export function reporterId() {
  try {
    let id = localStorage.getItem(REPORTER_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 16);
      localStorage.setItem(REPORTER_KEY, id);
    }
    return id;
  } catch {
    return "anon";
  }
}

/** 免 GitHub 帳號回報：POST 到 Worker 中繼（中繼驗 Turnstile 後 repository_dispatch）。 */
export async function submitReportViaRelay({ outcome, date, viewpoint, note, sun, cfToken, hp }) {
  try {
    const resp = await fetch(RELAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outcome, date, viewpoint: viewpoint || "", note: note || "",
        sun: sun || "", reporter: reporterId(), cf_token: cfToken || "", hp: hp || "",
      }),
    });
    if (resp.ok) return { ok: true };
    const data = await resp.json().catch(() => ({}));
    return { ok: false, status: resp.status, error: data.error };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

/** 公開回報路徑：預填的 Issue Form（任何 GitHub 使用者可用，機器人自動 ingest）。 */
export function reportIssueUrl(outcome, note = "", dateStr = "今天", sunZh = "") {
  const labels = { A: "A 灰暗沒色彩（低雲/降雨整片罩住）", B: "B 橘色天空／霞光（看不看得到太陽本身都算）",
    C: "C 局部火燒", D: "D 全面火燒" };
  const params = new URLSearchParams({
    template: "outcome_report.yml",
    outcome: labels[outcome] || "",
    date: dateStr,
  });
  if (sunZh) params.set("sun", sunZh);
  if (note) params.set("note", note);
  return `https://github.com/${REPO}/issues/new?${params}`;
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode */ }
}

async function api(path, options = {}) {
  const resp = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${getToken()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  return resp;
}

/** 測試 token 是否可讀 repo。 */
export async function testToken() {
  if (!getToken()) return { ok: false, message: "尚未輸入 token" };
  try {
    const resp = await api(`/repos/${REPO}`);
    if (resp.ok) return { ok: true, message: "✅ 連線成功" };
    return { ok: false, message: `❌ HTTP ${resp.status}（檢查 token 權限範圍）` };
  } catch (e) {
    return { ok: false, message: `❌ ${e.message}` };
  }
}

/** 觸發 on-demand-report workflow 寫入 outcomes.csv。 */
export async function dispatchReport(outcome, dateStr, note) {
  const resp = await api(
    `/repos/${REPO}/actions/workflows/on_demand_report.yml/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({
        ref: BRANCH,
        inputs: { outcome, date: dateStr, note: note || "" },
      }),
    },
  );
  if (resp.status === 204) return { ok: true };
  return { ok: false, status: resp.status };
}
