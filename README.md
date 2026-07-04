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
├── telegram_io.py  # 推播與訊息格式化（繁中、區間機率）
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

# 每日推播流程（未設 Telegram secrets 時只印到 stdout）
python -m sunset push-daily --no-send

# 回報今晚實際結果（寫入 data/logs/outcomes.csv，供持續性加成與校準）
python -m sunset report --outcome C --note "西北側局部燒"

# 本地長輪詢 bot（/sunset /report /viewpoints）
python -m sunset bot

# 測試與 lint
pytest
ruff check .
```

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

| Secret | 內容 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather 給的 token |
| `TELEGRAM_CHAT_ID` | 你的 chat id |

Token **絕不落地 repo**（程式碼與日誌皆不含 secrets）。

## 排程（GitHub Actions）

| Workflow | Cron (UTC) | 台北時間 | 內容 |
|---|---|---|---|
| `daily_forecast.yml` | `20 8 * * *` | 16:20 | 分析 → 推播判定 → commit 預測日誌 |
| `outcome_prompt.yml` | `15 11 * * *` | 19:15 | 推播詢問今晚實際結果 A/B/C/D |

註：GitHub Actions cron 有 ±數分鐘飄移，可接受。收到 19:15 詢問後用
`/report A|B|C|D [備註]`（本地 bot）或 `python -m sunset report` 回報，
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
