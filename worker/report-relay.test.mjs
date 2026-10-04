// report-relay.js 測試：以假的 fetch／caches 模擬 Cloudflare 執行環境。
import assert from "node:assert/strict";
import test from "node:test";
import worker from "./report-relay.js";

const ENV = {
  ALLOWED_ORIGIN: "https://viovenus.github.io",
  GH_OWNER: "VioVenus",
  GH_REPO: "taipei-sunset",
  GH_TOKEN: "ghp_test",
  TURNSTILE_SECRET: "ts_secret",
};

// 記錄所有對外呼叫；依網址回應預先設定的結果
function mockNet(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [pattern, reply] of routes) {
      if (String(url).includes(pattern)) {
        const { status = 200, body = {} } = typeof reply === "function" ? reply(init) : reply;
        return new Response(status === 204 ? null : JSON.stringify(body), { status });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => store.get(req.url),
      put: async (req, res) => { store.set(req.url, res); },
    },
  };
  return calls;
}

const post = (body, origin = ENV.ALLOWED_ORIGIN) =>
  new Request("https://relay.test/", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": `ip${Math.random()}` },
    body: JSON.stringify(body),
  });

test("POST 回報：驗證通過 → repository_dispatch 帶結構化欄位", async () => {
  const calls = mockNet([
    ["siteverify", { body: { success: true } }],
    ["/dispatches", { status: 204 }],
  ]);
  const res = await worker.fetch(post({ outcome: "b", date: "今天", sun: "visible", cf_token: "t", reporter: "abc" }), ENV);
  assert.equal(res.status, 200);
  const dispatch = calls.find((c) => c.url.endsWith("/repos/VioVenus/taipei-sunset/dispatches"));
  const payload = JSON.parse(dispatch.init.body);
  assert.equal(payload.event_type, "outcome-report");
  assert.equal(payload.client_payload.outcome, "B");
  assert.equal(payload.client_payload.sun, "有看到太陽本身");
  assert.equal(payload.client_payload.reporter, "web:abc");
});

test("POST 回報：Origin 不符 → 403 origin；Turnstile 失敗 → 403 captcha", async () => {
  mockNet([["siteverify", { body: { success: false } }]]);
  const bad = await worker.fetch(post({ outcome: "B" }, "https://evil.example"), ENV);
  assert.equal((await bad.json()).error, "origin");
  const cap = await worker.fetch(post({ outcome: "B", cf_token: "x" }), ENV);
  assert.equal(cap.status, 403);
  assert.equal((await cap.json()).error, "captcha");
});

test("POST 回報：GitHub 拒絕 → 502 並帶上游狀態碼", async () => {
  mockNet([["siteverify", { body: { success: true } }], ["/dispatches", { status: 401 }]]);
  const res = await worker.fetch(post({ outcome: "C", cf_token: "t" }), ENV);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "dispatch", status: 401 });
});

test("GET /health：設定齊全且可寫 → ready；不洩漏任何密鑰", async () => {
  mockNet([["/repos/VioVenus/taipei-sunset", { body: { permissions: { push: true } } }]]);
  const res = await worker.fetch(new Request("https://relay.test/health", { headers: { "CF-Connecting-IP": "h1" } }), ENV);
  const body = await res.json();
  assert.equal(body.ready, true);
  assert.equal(body.github.can_push, true);
  assert.equal(body.config.GH_TOKEN, true);
  assert.ok(!JSON.stringify(body).includes("ghp_test"));
  assert.ok(!JSON.stringify(body).includes("ts_secret"));
});

test("GET /health：token 失效 → 給出可行動提示", async () => {
  mockNet([["/repos/VioVenus/taipei-sunset", { status: 401, body: { message: "Bad credentials" } }]]);
  const res = await worker.fetch(new Request("https://relay.test/health", { headers: { "CF-Connecting-IP": "h2" } }), ENV);
  const body = await res.json();
  assert.equal(body.ready, false);
  assert.ok(body.hints.some((h) => h.includes("GH_TOKEN 無效")));
});

test("scheduled：08:20 UTC → daily_forecast.yml、11:15 UTC → outcome_prompt.yml", async () => {
  const calls = mockNet([["/dispatches", { status: 204 }]]);
  await worker.scheduled({ cron: "20 8 * * *", scheduledTime: Date.UTC(2026, 9, 5, 8, 20) }, ENV);
  await worker.scheduled({ cron: "15 11 * * *", scheduledTime: Date.UTC(2026, 9, 5, 11, 15) }, ENV);
  assert.ok(calls[0].url.endsWith("/actions/workflows/daily_forecast.yml/dispatches"));
  assert.equal(JSON.parse(calls[0].init.body).ref, "main");
  assert.ok(calls[1].url.endsWith("/actions/workflows/outcome_prompt.yml/dispatches"));
});

test("scheduled：GitHub 拒絕時拋錯（讓 Cloudflare 標示失敗）", async () => {
  mockNet([["/dispatches", { status: 403, body: { message: "Resource not accessible" } }]]);
  await assert.rejects(
    worker.scheduled({ cron: "20 8 * * *", scheduledTime: Date.UTC(2026, 9, 5, 8, 20) }, ENV),
    /HTTP 403/,
  );
});
