// 群眾回報中繼（Cloudflare Worker）——讓公開 PWA 免 GitHub 帳號、免跳轉回報。
//
// 流程：PWA POST JSON → 本 Worker 驗證（Turnstile 隱形驗證碼 + 蜜罐 + 速率限制 + 欄位檢查）
//        → GitHub repository_dispatch（event_type=outcome-report）→ ingest-dispatch workflow
//        → reports.csv（append-only）。token 與 Turnstile 密鑰只活在 Worker 環境變數，
//        絕不進前端（符合憲章：token 不落地公開站）。
//
// 另兩個用途：
//   GET /health  —— 自我診斷（只回布林值與狀態碼，不回任何密鑰），部署後打開即可驗收
//   scheduled()  —— Cloudflare Cron Triggers 準點觸發 GitHub workflow_dispatch。
//                   GitHub 自己的 schedule 常遲到 5–8 小時，日落預測必須準點。
//
// 部署見 docs/report-relay.md。所需環境變數：
//   ALLOWED_ORIGIN   例 https://viovenus.github.io（只放行你的站，擋跨站濫用）
//   GH_OWNER GH_REPO 例 VioVenus / taipei-sunset
//   GH_TOKEN         （secret）classic PAT 勾 `repo`（涵蓋 repository_dispatch 與
//                    workflow_dispatch）；或 fine-grained：Contents + Actions 皆 Read and write
//   TURNSTILE_SECRET （secret）Cloudflare Turnstile 密鑰
// 選用 KV binding：RL（速率限制；未綁定則退回 Cache API 軟限制）

const VALID_OUTCOMES = ["A", "B", "C", "D"];
const NOTE_MAX = 200;
const RATE_WINDOW_SEC = 20; // 同 IP 最短間隔
// 準點排程：以觸發時的 UTC 小時對應 workflow（不依賴 cron 字串的寫法）
const CRON_WORKFLOWS = {
  8: "daily_forecast.yml", // 08:20 UTC = 16:20 台北：當日日落判定
  11: "outcome_prompt.yml", // 11:15 UTC = 19:15 台北：回報提示
};

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "taipei-sunset-relay",
      "Content-Type": "application/json",
    },
  });
}

// GET /health：逐項檢查設定與 GitHub 權限，給出下一步提示
async function health(env) {
  const config = {
    ALLOWED_ORIGIN: env.ALLOWED_ORIGIN || null,
    GH_OWNER: env.GH_OWNER || null,
    GH_REPO: env.GH_REPO || null,
    GH_TOKEN: Boolean(env.GH_TOKEN),
    TURNSTILE_SECRET: Boolean(env.TURNSTILE_SECRET),
  };
  const out = { worker: "ok", config, github: null, hints: [] };
  if (config.ALLOWED_ORIGIN !== "https://viovenus.github.io") {
    out.hints.push("ALLOWED_ORIGIN 應為 https://viovenus.github.io（有 https、無結尾斜線、無路徑）");
  }
  if (!config.TURNSTILE_SECRET) out.hints.push("缺 TURNSTILE_SECRET（Secret 類型）");
  if (!config.GH_TOKEN || !config.GH_OWNER || !config.GH_REPO) {
    out.hints.push("缺 GH_TOKEN／GH_OWNER／GH_REPO");
    return out;
  }
  const r = await gh(env, "");
  const repo = await r.json().catch(() => ({}));
  const canPush = Boolean(repo.permissions && repo.permissions.push);
  out.github = { status: r.status, can_push: canPush };
  if (r.status === 401) out.hints.push("GH_TOKEN 無效或已過期 → 重新產生 classic PAT（勾 repo）");
  else if (r.status === 404) out.hints.push("找不到 repo → 檢查 GH_OWNER／GH_REPO，或 token 沒有此 repo 權限");
  else if (r.ok && !canPush) out.hints.push("token 只能讀不能寫 → classic PAT 需勾 repo");
  out.ready = r.ok && canPush && config.TURNSTILE_SECRET && out.hints.length === 0;
  return out;
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

async function verifyTurnstile(secret, token, ip) {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token || "");
  if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const data = await r.json().catch(() => ({ success: false }));
  return data.success === true;
}

function validDate(raw) {
  const t = (raw || "").trim();
  if (["", "今天", "today", "昨天", "yesterday"].includes(t)) return t || "今天";
  // 只接受今天/昨天/兩天內 ISO；更久的交給 ingest 再擋一次
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}

// 軟速率限制：優先用 KV（跨節點），否則退回 Cache API（單節點，弱但夠擋洗版）
async function rateLimited(env, ip) {
  const key = `rl:${ip}`;
  if (env.RL) {
    if (await env.RL.get(key)) return true;
    await env.RL.put(key, "1", { expirationTtl: RATE_WINDOW_SEC });
    return false;
  }
  const cache = caches.default;
  const cacheKey = new Request(`https://rl.local/${encodeURIComponent(ip)}`);
  if (await cache.match(cacheKey)) return true;
  await cache.put(
    cacheKey,
    new Response("1", { headers: { "Cache-Control": `max-age=${RATE_WINDOW_SEC}` } }),
  );
  return false;
}

export default {
  async scheduled(event, env) {
    const wf = CRON_WORKFLOWS[new Date(event.scheduledTime).getUTCHours()];
    if (!wf) {
      console.log(`cron "${event.cron}"：沒有對應的 workflow，略過`);
      return;
    }
    const r = await gh(env, `/actions/workflows/${wf}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: env.GH_BRANCH || "main" }),
    });
    const msg = `cron "${event.cron}" → ${wf}：HTTP ${r.status}`;
    // 拋錯讓 Cloudflare 儀表板把這次排程標成失敗，Logs 看得到原因
    if (!r.ok) throw new Error(`${msg} ${(await r.text()).slice(0, 200)}`);
    console.log(msg);
  },

  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      const ip = request.headers.get("CF-Connecting-IP") || "0";
      if (await rateLimited(env, `health:${ip}`)) return json({ error: "rate" }, 429, origin);
      return json(await health(env), 200, origin);
    }
    if (request.method !== "POST") return json({ error: "method", hint: "GET /health 可自我診斷" }, 405, origin);
    if (env.ALLOWED_ORIGIN && request.headers.get("Origin") !== env.ALLOWED_ORIGIN) {
      return json({ error: "origin" }, 403, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "json" }, 400, origin);
    }

    // 蜜罐：真人不會填 hp 欄位；有值就假裝成功、靜默丟棄（不給機器人回饋）
    if (body.hp) return json({ ok: true }, 200, origin);

    const outcome = String(body.outcome || "").trim().toUpperCase().slice(0, 1);
    if (!VALID_OUTCOMES.includes(outcome)) return json({ error: "outcome" }, 400, origin);

    const date = validDate(body.date);
    if (date === null) return json({ error: "date" }, 400, origin);

    if (!(await verifyTurnstile(env.TURNSTILE_SECRET, body.cf_token, request.headers.get("CF-Connecting-IP")))) {
      console.log("Turnstile 驗證失敗");
      return json({ error: "captcha" }, 403, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "0";
    if (await rateLimited(env, ip)) return json({ error: "rate" }, 429, origin);

    // 清洗：note 去換行（防在下游被解析成假欄位）、截長度；sun/viewpoint 白名單化
    const note = String(body.note || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, NOTE_MAX);
    const sun = ["visible", "blocked", "unknown"].includes(body.sun) ? body.sun : "";
    const viewpoint = String(body.viewpoint || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
    const reporter = ("web:" + String(body.reporter || "").replace(/[^A-Za-z0-9_-]/g, "")).slice(0, 40);
    const sunZh = sun === "blocked" ? "太陽被低雲擋住" : sun === "visible" ? "有看到太陽本身" : "";

    const dispatch = await gh(env, "/dispatches", {
      method: "POST",
      body: JSON.stringify({
        event_type: "outcome-report",
        client_payload: { outcome, date, viewpoint, note, sun: sunZh, reporter },
      }),
    });
    if (!dispatch.ok) {
      console.log(`repository_dispatch 失敗：HTTP ${dispatch.status}`);
      return json({ error: "dispatch", status: dispatch.status }, 502, origin);
    }
    return json({ ok: true }, 200, origin);
  },
};
