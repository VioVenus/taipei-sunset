# taipei-sunset 🌇

台北日落／火燒雲（burning cloud）自動預測系統 — Phase 0。

把「16:30 抬頭看西天」的人工決策規則自動化：

- **每日 16:20（台北時間）** 自動推播 Telegram：今晚日落判定（出發／跳過、推薦點位、四情境機率區間、理由）。
- **隨時查詢**：任意日期（今天～未來 3 天）× 任意已建檔點位的完整分析。
- **每次預測寫入日誌**（point-in-time、append-only），為後續校準與模型迭代累積資料。

四情境：**A** 低雲／降雨全擋、**B** 普通橘色夕陽、**C** 局部火燒雲、**D** 全面火燒雲。
機率一律輸出區間（±10 個百分點），不做假精確。

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

資料來源：Open-Meteo 逐時預報（免費無金鑰；分層雲量 low/mid/high 是核心輸入）。
CWA 開放資料為可選交叉驗證（Phase 0 為 stub，未設金鑰自動跳過）。
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

## Roadmap

- **Phase 0（本版）**：規則引擎 v1、Open-Meteo、Telegram 推播、日誌。
- Phase 1：CWA 交叉驗證實作、更多點位。
- Phase 2：以累積 ≥60 天的日誌做校準與調參（門檻 60 天，樣本不足不調參）。
- Phase 3：衛星雲圖／雷達整合。
