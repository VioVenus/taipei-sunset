# 免帳號回報中繼（Cloudflare Worker）部署指南

讓公開 PWA 的訪客**免 GitHub 帳號、免跳轉**回報 A–D：app 內按一下 → 隱形人機驗證
→ 即時寫回 `data/logs/reports.csv`（append-only）。token 只活在 Worker 設定，不進前端。

```
PWA 按 A–D ─POST─▶ Worker（驗 Turnstile+速率+Origin）─repository_dispatch─▶
  ingest-dispatch workflow ─▶ reports.csv
```

**未設定前**：`web/js/config.js` 的 `RELAY_URL`/`TURNSTILE_SITEKEY` 留空，
app 自動走原本的 Issue Form 流程，不會壞。以下做完、填上兩個值才切換。

---

## 方法 A：全程網頁 UI（推薦，免 CLI，約 10 分鐘）

### 第 1 步：Turnstile（隱形人機驗證，免費）
1. 登入 [dash.cloudflare.com](https://dash.cloudflare.com)（沒帳號先免費註冊）
2. 左欄 **Turnstile** → **Add widget**
   - Widget name：隨意（如 `sunset-report`）
   - Hostname：`viovenus.github.io`
   - Widget Mode：**Managed**
3. 建立後記下兩個值：**Site Key**（`0x4AAA…`，公開）與 **Secret Key**（機密）

### 第 2 步：GitHub token
用你已經熟的 classic PAT（跟 sync 那把**分開建**，職責單一）：
1. https://github.com/settings/tokens/new
2. Note：`sunset relay`；Expiration：**No expiration**（不再有過期地雷）
3. Scope 只勾 **`repo`** → Generate → 複製 `ghp_…`

### 第 3 步：建 Worker（貼程式碼）
1. Cloudflare 左欄 **Workers & Pages** → **Create** → **Create Worker**
   - 名稱：`taipei-sunset-report-relay` → **Deploy**（先部署預設樣板）
2. 進 Worker → **Edit code** → 全選刪掉，貼上本 repo `worker/report-relay.js` 的完整內容 → **Deploy**
3. Worker → **Settings** → **Variables and Secrets**，新增 5 筆：

   | 名稱 | 類型 | 值 |
   |---|---|---|
   | `ALLOWED_ORIGIN` | Text | `https://viovenus.github.io` |
   | `GH_OWNER` | Text | `VioVenus` |
   | `GH_REPO` | Text | `taipei-sunset` |
   | `GH_TOKEN` | **Secret** | 第 2 步的 `ghp_…` |
   | `TURNSTILE_SECRET` | **Secret** | 第 1 步的 Secret Key |

4. 記下 Worker 網址：`https://taipei-sunset-report-relay.<你的子域>.workers.dev`

### 第 4 步：接上前端（貼兩個值）
把「Worker 網址」和「Turnstile Site Key」交給維護流程（或自己編輯
`web/js/config.js` 的 `RELAY_URL` / `TURNSTILE_SITEKEY`）→ commit → sync。
完成後訪客在「紀錄」分頁按 A–D 直接送出，不跳任何頁面。

### 驗收
開 app（無痕視窗、不設 token）→ 紀錄分頁 → 按 B → 應顯示「✅ 已送出」；
1–2 分鐘後 repo 的 `data/logs/reports.csv` 多一列、Actions 有一次
`ingest-dispatch` 綠色執行。

---

## 方法 B：wrangler CLI（會用終端機的話）

```bash
cd worker
npx wrangler deploy
npx wrangler secret put GH_TOKEN
npx wrangler secret put TURNSTILE_SECRET
```
`wrangler.toml` 已含公開變數；（選用）KV 速率限制：
`npx wrangler kv namespace create RL` 後把 id 填進 `[[kv_namespaces]]`。

---

## 防濫用（已內建）
Turnstile 隱形驗證、蜜罐欄位、同 IP 速率限制（無 KV 時退回 Cache API 軟限制）、
Origin 白名單、Worker 與 ingest 兩端各驗一次、每裝置匿名 reporter_id
（同裝置同日只採計最新；多數決擋單一亂報者）。

## 停用
`config.js` 兩值清空即回 Issue Form 模式；Worker 可留著或刪除。

## 成本
Worker 免費層 10 萬請求/日、Turnstile 免費、Actions 公開 repo 免費——遠超日常所需。
