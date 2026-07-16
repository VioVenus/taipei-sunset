# 免帳號回報中繼（Cloudflare Worker）部署指南

讓公開 PWA 的訪客**免 GitHub 帳號、免跳轉**就能回報 A–D，資料仍落回你的
`data/logs/reports.csv`（append-only）。全程 token 不進前端。

```
PWA 按 A–D ─POST─▶ Cloudflare Worker（驗 Turnstile+速率）─repository_dispatch─▶
  ingest-dispatch workflow ─▶ reports.csv
```

**未部署前**：`web/js/config.js` 的 `RELAY_URL`/`TURNSTILE_SITEKEY` 留空，
app 自動走原本的預填 Issue Form 流程，什麼都不會壞。以下做完才會切換成免跳轉。

## 一次性部署（約 15 分鐘）

### 1. Cloudflare Turnstile（隱形人機驗證，免費）
1. Cloudflare 儀表板 → Turnstile → Add site。
2. Domain 填你的 Pages 網域（例 `viovenus.github.io`）。Widget 選 **Managed**。
3. 記下 **Site Key**（`0x4AAA…`，公開）與 **Secret Key**（機密）。

### 2. GitHub token（給 Worker 用）
建 **fine-grained PAT**，只授權 `VioVenus/taipei-sunset`：
- Repository permissions → **Contents: Read and write**（repository_dispatch 需要）。
- 有效期建議 90 天或自訂；到期要換。**這把 token 只放進 Worker 密鑰，不進前端。**

### 3. 部署 Worker
```bash
cd worker
npx wrangler deploy                      # 首次會要求登入 Cloudflare
npx wrangler secret put GH_TOKEN         # 貼上第 2 步的 PAT
npx wrangler secret put TURNSTILE_SECRET # 貼上第 1 步的 Secret Key
```
`wrangler.toml` 裡的 `ALLOWED_ORIGIN`/`GH_OWNER`/`GH_REPO` 若與預設不同請改。
部署後會得到一個網址，例 `https://taipei-sunset-report-relay.<子域>.workers.dev`。

（選用）跨節點速率限制：`npx wrangler kv namespace create RL`，把回傳的 id 填進
`wrangler.toml` 的 `[[kv_namespaces]]` 並取消註解、重新 deploy。未綁定則用 Cache API 軟限制。

### 4. 接上前端
編 `web/js/config.js`：
```js
export const RELAY_URL = "https://taipei-sunset-report-relay.<子域>.workers.dev";
export const TURNSTILE_SITEKEY = "0x4AAA…";  // 第 1 步的 Site Key
```
commit → 合併 → Pages 重新部署。完成：訪客在「紀錄」分頁按 A–D 直接送出，不跳 GitHub。

## 防濫用（已內建）
- **Turnstile**：隱形人機驗證，擋掉絕大多數機器人。
- **蜜罐欄位**：真人看不到、機器人常亂填 → 靜默丟棄。
- **速率限制**：同 IP 最短間隔（KV 跨節點或 Cache API 軟限制）。
- **Origin 白名單**：只放行你的 Pages 網域。
- **兩端驗證**：Worker 與 `ingest` 各驗一次（outcome A–D、日期今天/昨天、note 去換行截長）。
- **匿名身分**：每台裝置一個隨機 `reporter_id`（可清除），讓「同裝置同日只採計最新」與
  多數決共識可運作；單一亂報者無法翻轉共識（沿用既有 consensus 邏輯）。

## 停用
把 `config.js` 兩個值清空即可退回 Issue Form 流程；Worker 可留著或 `wrangler delete`。

## 成本
Cloudflare Worker 免費層 10 萬請求/日、Turnstile 免費、GitHub Actions 公開 repo 免費——
日常用量遠在免費額度內。
