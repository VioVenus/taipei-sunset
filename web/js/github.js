// GitHub 一鍵回報：以 fine-grained PAT 呼叫 workflow_dispatch（api.github.com 支援 CORS）。
// Token 只存 localStorage，絕不進任何遠端（除了 GitHub API 本身的 Authorization header）。

import { BRANCH, REPO } from "./logs.js";

const TOKEN_KEY = "sunset.gh_token";
export const ACTIONS_URL = `https://github.com/${REPO}/actions/workflows/on_demand_report.yml`;

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
