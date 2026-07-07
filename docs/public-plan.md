# 公開化規劃 v1 — 讓所有人都能使用與回報，仍然零後端、零月費

目標重述：從單人工具升級為**任何人都可以（1）收每日推播（2）查詢 PWA（3）回報實際結果
（4）給產品回饋**的公開服務，且維運成本維持 0、擁有者的資料紀律不被稀釋。

---

## 1. 假設破壞分析：單人版哪裡會斷？

| 元件 | 單人版假設 | 公開後的問題 | 對策（→ §節） |
|---|---|---|---|
| 推播 | ntfy 私密主題 = 憑證 | 主題公開後任何人**可寫入**（冒名推播） | §3 雙通道：TG 頻道（防冒名）＋ ntfy（低摩擦、告知風險） |
| 回報 | workflow_dispatch 需 repo 寫入權 | 一般使用者無權限 | §4 Issue Form → 機器人自動 ingest（**已實作**） |
| outcomes.csv | 一天一個真值 | 多人回報會衝突、可能亂報 | §5 reports.csv + 共識演算法（**已實作**） |
| Pages | 私有 repo 要付費 | — | 公開 repo：Pages 免費、**Actions 分鐘數也免費無上限** |
| Open-Meteo | 一人呼叫 | 千人呼叫？ | 客戶端直打 = 配額分散在各使用者 IP，天然水平擴展；已附 CC BY 4.0 出處 |
| 日誌讀取 | raw.githubusercontent | 公開 repo 反而更順（無權限問題）；CSV 年增量僅數百 KB | 量大再做 latest.json 快照（§7 G3） |
| 產品回饋 | 沒有管道 | 需要收斂機制，避免變成客服黑洞 | §6 分流模板＋標籤＋每週節奏 |

**關鍵成本結論**：公開 repo 讓兩個本來要錢/受限的東西變免費（Pages、Actions 分鐘數）。
規模到數千使用者前，帳單仍是 $0——瓶頸不在錢，在回饋治理（§6）。

## 2. 隱私與邊界（先講清楚，因為公開後不可逆）

- 公開內容：全部程式碼、規則常數、預測日誌、**回報紀錄（含 GitHub 帳號名與備註）**。
  Issue Form 已標示「內容公開，勿填個資」。
- 不公開：推播 secrets（在 GitHub Secrets，不隨 repo 公開）、使用者的 app 設定（localStorage 不離機）。
- 選擇「另開公開 repo 只放日落專案」正是為了讓上述邊界乾淨：其他私有工作不受影響。

## 3. 推播：從「私密憑證」改為「廣播頻道」

| 通道 | 訂閱摩擦 | 防冒名 | 建議角色 |
|---|---|---|---|
| **Telegram 公開頻道** | 點連結加入（一次） | ✅ 只有 bot 能發文 | **主廣播**。現有程式零修改：`TELEGRAM_CHAT_ID` 填頻道 `@名稱` 即可 |
| **ntfy 公開主題** | 裝 app 訂閱主題（一次） | ❌ 任何人可對公開主題發訊 | 免帳號備援。README 明示「僅信任 app/頻道內容，ntfy 訊息可能被冒發」 |
| PWA 開啟即看 | 零 | ✅ | 不裝任何東西的底線體驗 |

註：單人版「ntfy 主題名=秘密」的模型在公開化後失效，這是誠實的取捨，
不是 bug——防冒名的免費廣播就是 Telegram 頻道，故升為主通道。

## 4. 回報管線（已實作）：任何人 30 秒完成回報

```
使用者：PWA 紀錄分頁按 A/B/C/D
  → 開啟預填好的 GitHub Issue Form（登入 GitHub 即可，唯一帳號門檻）
  → 按 Submit
機器人（ingest_report.yml）：
  → 解析驗證（python -m sunset ingest-report，有單元測試）
  → 合格：append reports.csv → commit → 回覆「已記錄＋當日共識」→ 關閉 issue
  → 不合格：回覆原因 → 標 invalid → 關閉（不落檔，寧缺勿髒）
```

驗證規則（`src/sunset/ingest.py` 常數）：
- 結果必須 A/B/C/D；日期只收今天/昨天（回憶超過兩天不進校準資料）
- 備註消毒（單行、去控制字元、200 字上限——會進公開 CSV 與頁面）
- 點位不在建檔清單 → 留空仍收單（回報比點位精確重要）

擁有者的三條舊路（token 一鍵、workflow_dispatch、CLI）全部保留不變。

## 5. 資料模型與共識演算法（已實作）

- **reports.csv**（新，append-only）：`target_date, reported_at_utc, outcome,
  viewpoint_id, note, reporter, source`
- **outcomes.csv** 保留：聚合時視為 `reporter="owner"`，向後相容
- **共識規則**（`logbook.py`，Python 與 PWA 兩端同規則）：
  1. 每人每日只採計**最新一票**（可改口、灌票無效）
  2. 「昨日有燒」（持續性加成輸入）= 燒票（C/D）**過半**，平手取保守
  3. 顯示用共識字母 = 眾數，平手取較不戲劇的字母（反假精確的延伸）

**濫用抗性分析**：單一亂報者在 N≥3 時無法翻轉多數決；批量假帳號受 GitHub
反濫用機制與帳號成本約束；剩餘風險（協調式亂報）對「看夕陽」這種低利害場景
不值得攻擊。若真發生：GitHub block 使用者 + 從聚合排除（raw 列永不刪，符合
append-only——排除名單是聚合期參數，不是改歷史）。

**校準紅利與陷阱**：N 人回報讓樣本累積速度 ×N，但回報者站在不同點位、
標準不一（同一晚有人評 C 有人評 B）。Phase 2 校準時：以共識為主標籤、
保留 raw 票數分佈作為標籤雜訊估計；60 天門檻不變。

## 6. 產品回饋的處理方式（治理，不只是管道）

**分流**（三個 Issue Form，已建）：
| 模板 | 進什麼流程 |
|---|---|
| 🌇 結果回報 | 全自動：機器人 ingest，人類零介入 |
| 📍 新點位提議 | 人工流程：依 CONTRIBUTING 檢查清單實測驗證後才入庫（歷史教訓 1 的公開版） |
| 💬 產品回饋 | 每週人工 triage |

**處理節奏（單人維護者可持續的 SLA）**：
- 每週日看週報時順手 triage（與既有 weekly-review 習慣綁定，不新增儀式）
- 標籤系統：`confirmed-bug`（下次改版修）｜`rule-tuning`（**只進 Phase 2 校準
  待辦，絕不因單一回饋改規則常數**——防過度擬合單一抱怨）｜`wontfix`（回覆原則性理由）
- 「預測不準」類回饋：先問「當天你回報結果了嗎？」——把抱怨轉化為校準資料
- 明確承諾邊界寫進 CONTRIBUTING：這是興趣專案，回覆週期以週計，PR 歡迎

**規則變更紀律（公開版更重要）**：任何常數變動仍走 engine_version bump +
parity fixtures 重生成；變更理由必須引用日誌統計，不引用單一 issue。

## 7. 分階段路線

- **G0（遷移）**：建新公開 repo `taipei-sunset` → 推程式碼 → 設 secrets →
  開 Pages → 建 TG 頻道。詳細 runbook 見 §8。
- **G1（本次已實作）**：Issue Form 回報管線、共識聚合、PWA 公開回報路徑、
  三個回饋模板、治理文件。
- **G2（樣本/使用者達門檻後）**：共識校準（60 天）、貢獻者點位常態化、
  週報加入回報排行/感謝名單（社群回饋循環）。
- **G3（若量真的大）**：latest.json 快照取代整檔 CSV 拉取；自架 ntfy（ACL 防冒名）
  或 Cloudflare Workers 免費層做回報 API（免 GitHub 帳號）。**觸發條件：
  raw 拉取月流量 > 50GB 或「需要 GitHub 帳號」被證實是回報量瓶頸**，未觸發不做。
- 原生 App 路線不變（native-app-plan.md），公開化不改變其觸發條件。

## 8. G0 遷移 runbook（新公開 repo）

首次推送含 `.github/workflows/*`，GitHub 對 PAT 有 workflow scope 限制，兩條路擇一：

- **A. 本機 SSH 推送（推薦，SSH 金鑰不受 workflow scope 限制）**
  ```bash
  git remote add public git@github.com:<owner>/taipei-sunset.git
  git push --force public <本分支>:main
  ```
- **B. sync-public workflow（無本機環境時）**：secret `PUBLIC_REPO_TOKEN` 必須是
  **classic** PAT 且勾 `repo` + `workflow`（fine-grained PAT 無法推 workflow 檔）。
  Actions → sync-public → confirm 輸入 `push`。同步後可刪除該 token。

3. 改 `web/js/config.js` 的 REPO 為新名稱（單一檔案，一行）→ commit
4. 新 repo Settings：
   - Pages → Source = GitHub Actions
   - Secrets：`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`（=公開頻道 @名稱）
     和／或 `NTFY_TOPIC`
5. 建 Telegram 公開頻道，把 bot 加為管理員
6. Actions 手動跑一次 `daily-forecast` 驗證推播、開一張測試回報 issue 驗證 ingest
7. README 首段放：頻道連結、PWA 網址、回報說明——這是使用者唯一需要看的三行
