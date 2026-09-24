# Airflow 部署路徑

本目錄提供每日預測管線的 Apache Airflow 版本。

**GitHub Actions 仍是本專案的正式部署方式**（見 `.github/workflows/daily_forecast.yml`）。
Airflow 版存在的理由有兩個：自架者若已經有 Airflow 叢集，不必為了這條管線
再維護一套 Actions；以及——管線的結構在 DAG 裡是**顯式**的，
retry 策略、任務邊界、補跑語意都變成可以被測試釘住的宣告，
而不是散在 shell 步驟與 Python 函式呼叫順序裡的隱含約定。

兩邊共用 `sunset.pipeline` 的編排函式，**沒有第二份實作**
（本專案 CI 有一道 parity 檢查專門在擋評分引擎的實作漂移，編排層同理）。

## 結構

```
fetch_and_score ──┬── write_logbook   (append-only，真相源)
                  └── broadcast        (推播，best-effort)
```

## 幾個刻意的選擇

這些都由 `tests/test_airflow_dag.py` 釘住，改動會讓測試紅掉：

| 設定 | 值 | 理由 |
|---|---|---|
| `schedule` + `timezone` | `20 16 * * *` @ `Asia/Taipei` | 直接宣告台北時間。Actions 版得手算成 UTC `20 8 * * *` 並在註解裡承認「cron 有 ±數分鐘飄移」；時區宣告後日光節約與時區調整由 Airflow 處理 |
| `catchup` | `False` | Open-Meteo 只供應未來預報。補跑過去某天會拿到**今天**的預報、寫進那一天的列 —— point-in-time 日誌會被汙染成事後諸葛。這條管線漏掉就是漏掉，不補 |
| `max_active_runs` | `1` | `predictions.csv` 是 append-only，並行寫入會交錯出難以還原的順序。對應 Actions 版的 `concurrency: group: sunset-logs` |
| `write_logbook` retries | **0** | append-only 的重試會製造**重複列**而不是覆蓋。寧可紅掉讓人看一眼，也不要靜默污染校準資料 |
| `fetch_and_score` retries | 3 | 打外部天氣 API，重跑無副作用 |
| `broadcast` retries | 2 | 最壞情況是同一則訊息推兩次，可接受 |
| 日誌／推播的關係 | 平行，互不為上下游 | 兩者重要性不同：預測日誌是事後校準模型的唯一依據，推播漏一則不影響任何長期資料。Actions 版裡兩者是順序呼叫，寫日誌拋例外會連帶吃掉推播 |

### `data_interval_end` 而不是 `logical_date`

日排程在 D 日 16:20 觸發的 run，其 `logical_date` 是 **D-1** 16:20
（Airflow 的資料區間語意：logical_date = 區間起點）。這條管線預測的是
「觸發當下那天」的日落，不是回填某個歷史區間，所以取區間**結尾**。

這是 forecast 型管線與 backfill 型 ETL 最容易踩反的一點。

## 本地跑起來

```bash
pip install -e .                      # 讓 worker 找得到 sunset 套件
pip install "apache-airflow==3.0.3"   # 已在 Airflow 3.0.3 實測 DAG 可正常載入

export AIRFLOW_HOME="$PWD/.airflow_home"
export AIRFLOW__CORE__DAGS_FOLDER="$PWD/airflow/dags"
airflow standalone
```

推播通道與 CWA 交叉驗證走環境變數，與 CLI 相同：
`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`NTFY_TOPIC`、`CWA_API_KEY`。
一個都不設也能跑完整條管線 —— 推播是選配，`broadcast` 會回報「未設定通道，略過」。

### 跑 DAG 測試

```bash
pip install "apache-airflow==3.0.3" pytest
python -m pytest tests/test_airflow_dag.py -v
```

Airflow 未安裝時這些測試會自動跳過，所以本專案 CI（不裝 Airflow）不受影響。

## 尚未納入的排程

`prompt-outcome`（19:15 詢問當日實際結果）與 `weekly-review`（週報）
目前只有 Actions 版。兩者都是單一步驟的推播，拆成 DAG 的收益有限；
真正值得做成 DAG 的是它們與 `predictions.csv` 之間的回饋迴路
（預測 → 回報 → consensus → 隔日加成），那需要先把校準流程本身寫成管線。
