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

### 第 5 步：準點排程（Cron Triggers，強烈建議）
GitHub 自己的排程常遲到 5–8 小時（16:20 的預測拖到晚上才跑＝日落後才「預測」）。
讓 Worker 準點叫 GitHub 跑：
1. Worker → **Settings** → **Triggers** → **Cron Triggers** → **Add**
2. 新增兩筆（時間是 **UTC**，照抄即可）：
   - `20 8 * * *` → 台北 16:20 當日日落判定
   - `15 11 * * *` → 台北 19:15 回報提示
3. 存檔。用的是同一把 `GH_TOKEN`（classic `repo` 已涵蓋觸發 workflow 的權限）。

確認有效：隔天到公開 repo 的 Actions → `daily-forecast`，16:20 左右那筆的觸發來源
應顯示 **workflow_dispatch**（而不是 schedule）。

### 驗收（3 分鐘）
1. **自我診斷**：瀏覽器開 `https://<你的 Worker 網址>/health`，應看到 `"ready": true`。
   不是的話，`hints` 會直接寫出缺什麼（例：GH_TOKEN 無效、ALLOWED_ORIGIN 多了斜線）。
   這個頁面只回布林值與狀態碼，不會顯示任何密鑰。
2. **實際回報**：開 app（無痕視窗）→ 紀錄分頁 → 按 B → 應顯示「✅ 已送出」；
   1–2 分鐘後公開 repo 的 `data/logs/reports.csv` 多一列、Actions 有一次
   `ingest-dispatch` 綠色執行。
3. 失敗時 app 會直接顯示原因碼＋一個「改用 GitHub 表單回報」連結（永不卡在驗證中）：

   | 畫面上的原因碼 | 意思 | 怎麼修 |
   |---|---|---|
   | `load` | Turnstile 腳本載入失敗（廣告攔截／網路） | 換網路或關攔截；表單備援可用 |
   | `110200` 等數字 | Turnstile widget 錯誤（110200＝網域未授權） | widget 的 Hostname 加入 `viovenus.github.io` |
   | `captcha 403` | 驗證碼對不上 | `TURNSTILE_SECRET` 要是同一個 widget 的 Secret Key |
   | `origin 403` | 來源網域不符 | `ALLOWED_ORIGIN` 改成 `https://viovenus.github.io` |
   | `dispatch 401` | GitHub token 無效或過期 | 重新產生 classic PAT（勾 `repo`）更新 `GH_TOKEN` |
   | `dispatch 404` | 找不到 repo 或沒權限 | 檢查 `GH_OWNER`／`GH_REPO`、token 權限 |

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
