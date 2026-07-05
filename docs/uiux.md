# taipei-sunset App — UI/UX 完整規劃書

版本：v1.0（Phase 1 PWA 依此實作）
範圍：PWA（本版實作）＋原生 App 路線（附錄，僅規劃）

---

## 1. 產品定位與設計原則

**一句話**：把「16:30 抬頭看西天」變成一眼可讀的決策卡片。

單一使用者（具量化背景的投資分析師），對應五條設計原則：

| # | 原則 | 落實 |
|---|---|---|
| P1 | **決策優先**：3 秒內看懂「出發／跳過」 | 首屏大字判定卡，細節收在下方 |
| P2 | **誠實的不確定性**：機率一律區間，禁止假精確 | 所有機率顯示 `30–50%`，配區間條而非單點數字 |
| P3 | **紀律可見**：初步展望必須看起來就「不那麼可信」 | preliminary 狀態用虛線邊框＋明顯角標 |
| P4 | **降級不崩潰**：沒網路、API 失敗都有明確畫面 | 每個資料元件都有 loading／錯誤／過期三態 |
| P5 | **零維運**：無後端、無資料庫 | 純靜態 PWA + 客戶端直打 Open-Meteo（支援 CORS）＋ GitHub API |

**明確不做**（本版）：多使用者、帳號系統、地圖選點、相機、社群分享。

## 2. 使用者旅程（Journeys）

### J1 每日 16:20 決策（核心，頻率：每日）
```
16:20 收到推播（ntfy/Telegram，維持現有管線）
 → 點開 app（或推播內容已足夠決策，不開 app）
 → 首屏：今晚判定卡（出發・劍潭山｜火燒雲 30–50%）
 → 往下滑看理由與時間表 → 決定出發
 → 「加入行事曆」不做；改做「時間表一鍵複製」
```
**設計含意**：首屏必須等同推播內容的超集合；開 app 的價值 = 理由、時間軸、其他點位比較。

### J2 隨時查詢（頻率：每週數次）
```
想知道週六適不適合約拍 → 開 app → 日期 chips 切「後天」
 → 看初步展望（明顯標註信心低）→ 週六 16:20 再確認
```

### J3 19:15 結果回報（頻率：每日，是校準資料的命脈）
```
收到 19:15 推播 → 開 app →「回報」分頁 → 點 A/B/C/D 大按鈕
 → （已設 GitHub token）一鍵送出 → 顯示「已寫入 outcomes.csv」
 → （未設 token）跳轉 GitHub Actions 頁面手動 Run
```
**設計含意**：回報摩擦每多一步，校準樣本就少一天。四個大按鈕 + 一次性 token 設定。

### J4 週回顧（頻率：每週）
```
週日 20:00 收到週報推播 → 開 app「紀錄」分頁
 → 看 7 天預測 vs 回報、覆蓋率、錯過/落空明細
```

### J5 新點位建檔（Phase 2，本版不做 UI）
維持人工流程：實測座標 → PR 修改 viewpoints.json（歷史教訓 1：禁止 app 內隨手加點）。

## 3. 資訊架構（IA）

```
底部導覽（3 分頁）
├── 🌇 預報（預設首頁）
│   ├── 日期 chips：今天｜明天｜後天（+日期選擇器）
│   ├── 推薦判定卡（大）
│   ├── 太陽時間軸（黃金時段→日落→有效沒入→藍調結束）
│   ├── 情境機率條（A/B/C/D 堆疊 + 區間文字）
│   ├── 理由清單
│   └── 其他點位卡（可展開成完整分析）
├── 📝 紀錄
│   ├── 今晚回報區（A/B/C/D 四大按鈕 + 備註）
│   ├── 本週統計卡（= 週報內容）
│   └── 歷史清單（predictions × outcomes 配對表）
└── ⚙️ 設定
    ├── GitHub token（選填，存 localStorage，用於一鍵回報）
    ├── 資料來源狀態（Open-Meteo 連線、日誌檔新鮮度）
    └── 關於／版本／engine_version
```

**導覽深度 ≤ 2**：任何資訊最多「分頁 → 展開卡片」兩層。

## 4. 畫面規格

### 4.1 預報分頁（首屏）

**版面（行動優先，360–430px 寬設計）**：
```
┌──────────────────────────────┐
│ 7/4（六）   [今天][明天][後天] │ ← sticky 頂欄，日期 chips
├──────────────────────────────┤
│ ╭─ 判定卡 ───────────────────╮│
│ │ 出發 🌇        推薦：劍潭山 ││ ← 判定字 28px 粗體
│ │ 火燒雲 30–50%  看日落 55–75%││ ← 兩個彙總區間，等寬並排
│ │ [────▓▓▓▓░░────] 區間條     ││
│ ╰────────────────────────────╯│
│ ── 太陽時間軸 ──               │
│ 17:56 ─── 18:38 ─ 18:47 ─ 19:13│
│ 黃金起   有效沒入  日落   藍調終 │ ← 水平時間軸，現在時刻打點
│ ── 情境機率 ──                 │
│ [A▓▓▓|B▓▓▓▓|C▓▓▓▓▓|D▓▓]      │ ← 100% 堆疊條，情境色
│ A 擋光 15–35%・B 普通 20–40%   │
│ C 局部燒 20–40%・D 全面燒 5–25%│
│ ── 理由 ──                     │
│ ・低雲 18%（地平線有縫）        │
│ ・高雲 52%（有燃料）            │
│ ・雨後放晴加成 +20              │
│ ── 其他點位 ──                 │
│ ▸ 大稻埕碼頭  火燒雲 30–50%    │ ← 點擊展開完整卡
├──────────────────────────────┤
│   🌇 預報   📝 紀錄   ⚙️ 設定  │ ← 底部導覽
└──────────────────────────────┘
```

**狀態機**（每次載入/切日期/切點位都走一遍）：

| 狀態 | 視覺 | 文案 |
|---|---|---|
| loading | 骨架屏（卡片灰塊脈動） | — |
| ok | 正常卡片 | 底部小字「資料時間 16:18」 |
| preliminary | 卡片虛線邊框＋琥珀角標 | 「📌 初步展望・信心低，以 16:20 推播為準」 |
| no-data | 判定卡變灰、只顯示太陽幾何 | 「⚠️ 天氣資料不足（原因）」＋重試鈕 |
| stale | 正常卡片＋琥珀提示列 | 「離線快取・資料時間 12:03」 |

太陽幾何（純本地計算）**永遠可用**——即使完全離線，時間軸與方位照常顯示，只有天氣/評分降級。

**互動**：
- 日期 chips：即時切換（<100ms 骨架 → 資料）；超過後天的日期用原生 date input，超出 +3 天直接 disabled 並提示紀律原因。
- 判定卡點擊 → 展開理由（預設已展開，收合記憶在 localStorage）。
- 時間表長按/按鈕 → 複製純文字到剪貼簿。
- 下拉不做 pull-to-refresh（PWA 手勢衝突），改右上 ↻ 鈕。

### 4.2 紀錄分頁

- **回報區**：`今晚（7/4）實際結果？` + 四個 56px 高大按鈕（A 灰、B 橘、C 橙紅、D 赤紅）＋選填備註欄。
  - 已設 token：點擊 → confirm sheet →呼叫 GitHub API dispatch `on_demand_report.yml` → 成功 toast「已送出，1–2 分鐘後寫入日誌」。
  - 未設 token：按鈕變成「前往 GitHub 回報 ↗」深連結（預填說明）。
  - 19:15 前顯示提示「太陽還沒下山」但不鎖（提前回報 A 的雨天場景合法）。
- **本週統計卡**：同週報訊息內容的視覺化（覆蓋率、出發命中、跳過錯過、平均 C+D vs 實際比例）。
- **歷史清單**：日期倒序，每列 = `日期｜判定｜預測C+D區間｜實際結果`，實際結果用情境色點。資料來源 raw.githubusercontent.com 的 CSV（cache-bust），離線退回部署時打包的副本並標 stale。

### 4.3 設定分頁

- GitHub token：password input，只存 localStorage，旁註「fine-grained token，只勾本 repo 的 Actions:write」。「測試連線」鈕。
- 資料狀態：Open-Meteo 最近一次成功時間；日誌 CSV 最後更新日。
- 關於：engine_version（從打包的常數讀）、規則引擎連結至 lessons.md。

## 5. 視覺設計

### 5.1 色彩

深色為預設（看夕陽的人晚上看手機），亮色完整支援（`prefers-color-scheme` + 手動切換）。

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `--bg` | `#14161d` | `#faf7f2` | 頁面底 |
| `--surface` | `#1e2129` | `#ffffff` | 卡片 |
| `--text` | `#f2efe9` | `#2a2622` | 主文字 |
| `--muted` | `#9a958c` | `#8a8177` | 次要文字 |
| `--accent` | `#ff8a3d` | `#e56a1f` | 主行動色（夕陽橘） |
| `--go` | `#ffb347` | `#e08a00` | 判定「出發」 |
| `--skip` | `#7d8794` | `#6b7684` | 判定「跳過」 |
| `--warn` | `#e8b64c` | `#b8860b` | preliminary/stale |
| 情境 A | `#5c6470` | `#8b95a3` | 灰（擋光） |
| 情境 B | `#d99a5b` | `#d99a5b` | 淡橘（普通） |
| 情境 C | `#f2703e` | `#e05a28` | 橙紅（局部燒） |
| 情境 D | `#d63a2f` | `#c22f24` | 赤紅（全面燒） |

情境色四色在灰階下亮度遞減（A 最亮灰 → D 最深），確保色盲/灰階可辨；堆疊條同時標註字母。

### 5.2 字體與排版

- 系統字體棧：`"PingFang TC", "Noto Sans TC", system-ui, sans-serif`（不載入 webfont——離線優先）。
- 數字用 `font-variant-numeric: tabular-nums`（區間對齊）。
- 層級：判定字 28/700、彙總區間 20/600、內文 15/400、註腳 12/400；行高 1.5。
- 間距 8px 網格；卡片圓角 16px；觸控目標 ≥44px。

### 5.3 圖示與 App icon

- 介面圖示用 emoji＋少量 inline SVG（免圖示字型）。
- App icon：深靛藍→橘紅漸層天空＋白色半沉太陽＋深色地平線；512/192 maskable PNG＋180 apple-touch-icon。

## 6. PWA 技術規格

| 面向 | 決策 |
|---|---|
| 架構 | 無框架 vanilla ES modules（守「不引框架」精神；總 JS < 50KB） |
| 計算 | `solar.js`/`geometry.js`/`scoring.js` 從 Python **逐式移植**；Python 為 canonical，`node --test` 跑 parity 測試比對 Python 產生的 fixtures，CI 擋漂移 |
| 天氣 | 客戶端直打 Open-Meteo（CORS 開放、免金鑰）；timeout 10s、重試一次、失敗降級——與 Python 同紀律 |
| 離線 | Service Worker：app shell cache-first；天氣 network-only（過期預報比沒有危險）＋ 最後成功回應存 localStorage 標 stale |
| 安裝 | manifest（standalone、theme_color、maskable icons）→ Android WebAPK／iOS 加入主畫面 |
| 推播 | **不做 Web Push**（iOS 不可靠且需伺服器），推播維持 ntfy/Telegram 管線；app 是查詢/回報介面 |
| 回報寫入 | GitHub REST `workflow_dispatch`（api.github.com 支援 CORS），fine-grained PAT 存 localStorage |
| 部署 | GitHub Pages（Actions workflow：web/ + data/ → artifact → deploy） |
| 隱私 | 無追蹤、無 analytics、token 不離開裝置 |
| Demo 模式 | `?demo=1` 用內建天氣 stub（開發截圖/展示/無網環境） |

**無障礙**：所有互動元件可鍵盤操作；堆疊條有 `aria-label` 完整文字；對比 ≥ 4.5:1；`prefers-reduced-motion` 停用脈動動畫。

**效能預算**：首載 ≤ 100KB（gzip 前）、TTI < 1s（4G）、Lighthouse PWA installable 全過。

## 7. 驗收清單（PWA）

- [ ] 三分頁完整；預報卡五狀態（loading/ok/preliminary/no-data/stale）皆可觸發
- [ ] 太陽幾何離線可用；日期限制今天–後天+紀律文案
- [ ] 機率全區間顯示；情境條含字母標註
- [ ] parity 測試：solar/scoring/geometry JS vs Python fixtures 全過（CI）
- [ ] manifest+SW+icons：Chrome 可安裝、iOS 可加主畫面
- [ ] 回報：token 一鍵 dispatch 成功；無 token 深連結可用
- [ ] 深/亮色完整；360px 寬無橫向捲動

## 附錄 A：原生 App 路線（規劃，不在本版實作）

**結論：先不做原生。** PWA 安裝到主畫面後已覆蓋 90% 需求（全螢幕、icon、離線 shell）。剩下的 10%（可靠的系統級推播）由 ntfy app 補齊，成本近零。

若日後仍要原生（觸發條件：iOS 推播必須整合進同一個 app、或需要背景定位提醒）：

1. **殼**：Capacitor 包現有 web/（不重寫 UI）；`npx cap add ios android`。
2. **推播**：Capacitor Push Notifications plugin（FCM/APNs）；發送端把現有 notify.py 加一個 FCM channel（需 Firebase 專案金鑰進 GitHub Secrets）。
3. **發佈成本（誠實帳）**：Apple Developer USD 99/年＋審核、簽章、每年跟版；單人工具 ROI 低。
4. **不變式**：評分引擎仍以 Python 為 canonical，原生殼內仍跑同一份 JS——絕不出現第三份實作。

## 附錄 B：與現有管線的關係

```
GitHub Actions（cron）──→ ntfy/Telegram 推播（決策入口）
        │ commit logs                      │ 點開
        ▼                                  ▼
data/logs/*.csv ←── raw.github ←──  PWA（查詢/回報/回顧）
        ▲                                  │ workflow_dispatch（token）
        └──────── on_demand_report.yml ←───┘
```
PWA 不引入任何新後端；所有寫入仍走 Actions → git commit（append-only 紀律不變）。
