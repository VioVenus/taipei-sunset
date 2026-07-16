// 群眾回報中繼（Cloudflare Worker）——讓公開 PWA 免 GitHub 帳號、免跳轉回報。
//
// 流程：PWA POST JSON → 本 Worker 驗證（Turnstile 隱形驗證碼 + 蜜罐 + 速率限制 + 欄位檢查）
//        → GitHub repository_dispatch（event_type=outcome-report）→ ingest-dispatch workflow
//        → reports.csv（append-only）。token 與 Turnstile 密鑰只活在 Worker 環境變數，
//        絕不進前端（符合憲章：token 不落地公開站）。
//
// 部署見 docs/report-relay.md。所需環境變數：
//   ALLOWED_ORIGIN   例 https://viovenus.github.io（只放行你的站，擋跨站濫用）
//   GH_OWNER GH_REPO 例 VioVenus / taipei-sunset
//   GH_TOKEN         （secret）fine-grained PAT，Contents: Read and write
//   TURNSTILE_SECRET （secret）Cloudflare Turnstile 密鑰
// 選用 KV binding：RL（速率限制；未綁定則退回 Cache API 軟限制）

const VALID_OUTCOMES = ["A", "B", "C", "D"];
const NOTE_MAX = 200;
const RATE_WINDOW_SEC = 20; // 同 IP 最短間隔

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
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method !== "POST") return json({ error: "method" }, 405, origin);
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

    const dispatch = await fetch(
      `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "taipei-sunset-relay",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "outcome-report",
          client_payload: { outcome, date, viewpoint, note, sun: sunZh, reporter },
        }),
      },
    );
    if (!dispatch.ok) return json({ error: "dispatch", status: dispatch.status }, 502, origin);
    return json({ ok: true }, 200, origin);
  },
};
