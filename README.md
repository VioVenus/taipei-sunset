# taipei-sunset 🌇

台灣日落／火燒雲（burning cloud）自動預測系統（repo 名 `taipei-sunset` 沿用，涵蓋已擴及全台）。

> © 2026 VioVenus・**非商業授權**：可看、可學、可自架自用、歡迎回報貢獻；
> 未經書面同意不得商業使用。詳見 [LICENSE](LICENSE)，第三方資料歸屬見 [NOTICE.md](NOTICE.md)。

把「16:30 抬頭看西天」的人工決策規則自動化：

- **每日 16:20（台北時間）** 自動推播 Telegram：今晚日落判定（出發／跳過、推薦點位、四情境機率區間、理由）＋**全台各區最佳**摘要。
- **隨時查詢**：任意日期（今天～未來 3 天）× 全台已建檔點位；PWA 依**地區分頁**或**定位找最近**選點。
- **更精準**：評估窗口以當日該點**實際日落時刻**為中心（跨全台緯度與四季）；多模式分歧動態加寬機率區間；CWA 全台縣市交叉驗證。
- **每次預測寫入日誌**（point-in-time、append-only），為後續校準與模型迭代累積資料。

四情境：**A** 低雲／降雨全擋、**B** 普通橘色夕陽、**C** 局部火燒雲、**D** 全面火燒雲。
機率一律輸出區間（±10 個百分點），不做假精確。

## 一般使用者：三步開始

1. **收每日 16:20 推播**：加入 Telegram 頻道（連結見 repo 首頁說明）；
   或裝 [ntfy](https://ntfy.sh) 訂閱公告的主題（注意：ntfy 公開主題可能被冒發，
   以頻道與 app 內容為準）。
2. **查詢**：開 PWA 網址（見 repo About），可加入手機主畫面當 app 用。
3. **看完日落回報**：app「紀錄」分頁按 A/B/C/D → GitHub 表單送出，機器人自動記錄。
   多人回報以多數決聚合，是校準資料的來源。參與方式詳見 [CONTRIBUTING.md](CONTRIBUTING.md)，
   公開化架構見 [docs/public-plan.md](docs/public-plan.md)。

## 架構

```
src/sunset/
├── solar.py        # NOAA 太陽幾何（純 stdlib）：日落時刻/方位、黃金時段、民用曙暮光
├── geometry.py     # bearing/距離、視線對位判定、遮蔽 → 提前沒入分鐘數
├── weather.py      # OpenMeteoFetcher（主力）、CWAFetcher（stub）、WeatherWindow 介面
├── scoring.py      # 規則引擎 v1：分層雲量 → 四情境機率 + 理由（常數集中，便於校準）
├── analysis.py     # 組裝層：date × viewpoint → 幾何 + 天氣 + 評分 + 時間表
├── logbook.py      # predictions.csv / outcomes.csv（append-only）
├── review.py       # 週報：過去 7 天預測 vs 回報 + 未來展望
├── telegram_io.py  # Telegram 訊息格式化與 bot（繁中、區間機率）
├── notify.py       # 統一推播層：Telegram + ntfy 多通道
└── cli.py          # python -m sunset <subcommand>
```

資料來源與角色分級見 [docs/data-sources.md](docs/data-sources.md)：
Open-Meteo best_match 為引擎輸入（評估窗口以實際日落時刻為中心，v1.2.0）；
ICON/GFS 多模式分歧驅動**動態不確定性區間**（±10 → 最寬 ±25）；
CWA（設 `CWA_API_KEY` 後啟用）為**全台縣市**交叉驗證；
雷達/衛星/即時影像（YouTube 直播 lite-facade 內嵌）為出發前人眼確認。
**禁止爬天氣網頁 HTML**，設計原則見 [docs/lessons.md](docs/lessons.md)。

## 本地執行

```bash
# 安裝（Python 3.11+，核心計算零第三方依賴，僅 requests 用於 API）
pip install -e ".[dev]"

# 單點分析
python -m sunset analyze --date 2026-07-04 --viewpoint jiantan_laodifang
python -m sunset analyze --date 明天            # 不指定點位 → 自動推薦

# 列出已建檔點位
python -m sunset viewpoints

# 每日推播流程（未設推播 secrets 時只印到 stdout）
python -m sunset push-daily --no-send

# 週報（過去 7 天預測 vs 回報 + 未來展望）
python -m sunset weekly-review --no-send

# 回報今晚實際結果（寫入 data/logs/outcomes.csv，供持續性加成與校準）
python -m sunset report --outcome C --note "西北側局部燒"

# 本地長輪詢 bot（/sunset /report /viewpoints）
python -m sunset bot

# 測試與 lint
pytest
ruff check .
```

## 推播通道：ntfy（最低摩擦，推薦）或 Telegram

兩個通道擇一即可，都設定就雙發。

### ntfy（免申請、免金鑰，就是一個手機 app）

1. 手機裝 [ntfy](https://ntfy.sh)（App Store / Google Play）。
2. 在 app 裡訂閱一個**長隨機字串**主題（例如 `taipei-sunset-x7Kq9mZx3f`——
   主題名就是唯一的存取憑證，別用可猜到的名字）。
3. 設定 secret／環境變數 `NTFY_TOPIC=taipei-sunset-x7Kq9mZx3f`。完成。

## Telegram bot 申請（三步驟）

1. **建 bot**：在 Telegram 找 [@BotFather](https://t.me/BotFather)，發送 `/newbot`，
   依指示命名後取得 **bot token**（格式 `123456789:ABC-DEF...`）。
2. **取得 chat id**：對你的新 bot 發送任意訊息，然後開
   `https://api.telegram.org/bot<TOKEN>/getUpdates`，
   回應 JSON 中 `message.chat.id` 就是 **chat id**。
3. **設定環境變數**（本地）：
   ```bash
   export TELEGRAM_BOT_TOKEN="123456789:ABC-DEF..."
   export TELEGRAM_CHAT_ID="987654321"
   ```

## GitHub Secrets 設定

Repo → Settings → Secrets and variables → Actions → New repository secret：

| Secret | 內容 | 必要性 |
|---|---|---|
| `NTFY_TOPIC` | ntfy 主題名（長隨機字串） | 與 Telegram 擇一 |
| `TELEGRAM_BOT_TOKEN` | BotFather 給的 token | 與 ntfy 擇一 |
| `TELEGRAM_CHAT_ID` | 你的 chat id | 同上 |
| `CWA_API_KEY` | CWA 開放資料金鑰（opendata.cwa.gov.tw 免費註冊） | 選填：啟用交叉驗證 |

Token **絕不落地 repo**（程式碼與日誌皆不含 secrets）。

## 排程與 on-demand（GitHub Actions）

| Workflow | 觸發 | 台北時間 | 內容 |
|---|---|---|---|
| `daily_forecast.yml` | cron `20 8 * * *` | 每日 16:20 | 分析 → 推播判定 → commit 預測日誌 |
| `outcome_prompt.yml` | cron `15 11 * * *` | 每日 19:15 | 推播詢問今晚實際結果 A/B/C/D |
| `weekly_review.yml` | cron `0 12 * * 0` | 週日 20:00 | 週報：7 天預測 vs 回報 + 未來展望 |
| `on_demand_forecast.yml` | 手動 Run workflow | 隨時 | 查任意日期×點位，推播 + 記日誌 |
| `on_demand_report.yml` | 手動 Run workflow | 隨時 | 回報 A/B/C/D → commit outcomes.csv |

註：GitHub Actions cron 有 ±數分鐘飄移，可接受。

**隨時查詢／回報（手機可用）**：裝 GitHub 手機 app → 本 repo →
Actions → 選 `on-demand-forecast`（或 `on-demand-report`）→ Run workflow →
填日期／點位（或結果 A–D）→ 結果推播到你的通道。不需要本機環境。

結果回報（19:15 詢問後）可走三條路之一：`on-demand-report` workflow、
本地 bot 的 `/report A|B|C|D [備註]`、或 `python -m sunset report`。
回報會成為隔天「昨日有燒」持續性加成的資料來源。

## 日誌紀律（point-in-time）

- `data/logs/predictions.csv`：每次預測一列，**寫入後永不修改**；
  同一天多次預測允許多列（以 `predicted_at_utc` 區分）。
- `data/logs/outcomes.csv`：實際結果回報。
- 校準時只用「當日最後一次 16:20 前後的預測」對 outcome。
- `engine_version` 自 `v1.0.0` 起算，任何規則常數變動都要 bump。

## PWA（手機 App）

`web/` 是可安裝的 PWA（設計規格見 [docs/uiux.md](docs/uiux.md)）：

- **部署**：merge 到 main 後由 `pages.yml` 自動發佈到 GitHub Pages
  （repo Settings → Pages → Source 選「GitHub Actions」啟用一次即可）。
- **安裝**：手機開啟 Pages 網址 → Android「安裝應用程式」／iOS「加入主畫面」。
- **功能**：**地區分頁（北/中/南/東/離島）＋定位找最近**選點、日期（今天～+3 天）查詢、
  判定卡、**「現在的光」**（白天/黃金/餘燼窗口/藍調結束 → 對應行動與拍攝建議；
  餘燼窗口特別提醒「火燒雲高峰常在日落後 10–20 分」別提早走）、太陽時間軸、
  四情境機率條、**出發前即時影像**（YouTube 直播點縮圖才載入）、
  回報 A/B/C/D（含今天預測脈絡、本機已回報記憶、歷史方向欄 ✓/✗）、本週統計。
- **維護者模式**：token 介面預設隱藏（站是公開的）；設定頁連點「關於」版本文字
  7 下開啟——這是介面整理不是保密，真機密只存 GitHub Secrets。
- **紀律**：太陽幾何本地計算（離線可用）；機率一律區間；初步展望明確標註；
  草稿座標點明確標「待實地確認」；API 失敗降級不崩潰。
  推播仍走 ntfy/Telegram（iOS Web Push 不可靠，不做）。
- **雙實作防漂移**：評分引擎以 Python 為 canonical；
  `scripts/gen_parity_fixtures.py` 產生 fixtures，CI 跑
  `node --test web/test/parity.test.mjs` 比對 JS 移植版（solar/geometry/scoring）。
- **本地開發**：`python -m http.server -d web`，瀏覽 `http://localhost:8000/?demo=1`
  （demo 模式用擬真天氣，無網可跑）。

## Roadmap

- **Phase 0**：規則引擎 v1、Open-Meteo、推播、日誌。
- **Phase 1**：PWA、週報、on-demand、ntfy。
- **v1.1.0**：多模式動態不確定性區間、CWA 交叉驗證、出發前人眼確認連結。
- **v1.2.0（本版）**：**全台化**——地區/縣市資料模型、動態日落窗口（跨全台與四季更準）、
  CWA 全台縣市交叉驗證、地區分頁＋定位找最近、即時影像 lite-facade 內嵌。
  草稿點位陸續實地確認座標與遮蔽後轉為已驗證。
- Phase 2：以累積 ≥60 天的日誌做校準與調參（門檻 60 天，樣本不足不調參）。
- Phase 3：衛星雲圖／雷達整合。
