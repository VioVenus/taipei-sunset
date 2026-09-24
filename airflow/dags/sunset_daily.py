"""每日日落預測管線（Airflow 版）。

與 `.github/workflows/daily_forecast.yml` 是**同一條管線的兩個部署目標**，
共用 `sunset.pipeline` 的編排函式，沒有第二份實作。

```
fetch_and_score ──┬── write_logbook   (append-only，真相源)
                  └── broadcast        (推播，best-effort)
```

為什麼要拆成三個任務：在 Actions 版裡三步是同一個行程內的順序呼叫，
「寫日誌」若拋例外，推播就跟著不會發生 —— 但這兩件事的重要性其實不同。
預測日誌是 point-in-time 紀錄、是事後校準模型的唯一依據；推播只是通知，
今天漏掉一則不影響任何長期資料。拆開之後兩者互不牽連，而且各自的
retry 策略可以不一樣（見下）。這個意圖本來只存在於註解裡，現在是結構。

retry 策略刻意不一致：
- `fetch_and_score` 打外部天氣 API，retries=3。重跑無副作用。
- `write_logbook` **retries=0**。predictions.csv 是 append-only，
  重試會製造重複列而不是覆蓋（見 pipeline.write_predictions 的說明）。
  寧可讓它紅掉由人看一眼，也不要靜默污染校準資料。
- `broadcast` retries=2。重試最壞情況是同一則訊息推兩次，可接受。
"""

from __future__ import annotations

from datetime import timedelta

import pendulum
from airflow.decorators import dag, task

TAIPEI = pendulum.timezone("Asia/Taipei")


@dag(
    dag_id="sunset_daily",
    description="台灣日落／火燒雲每日預測：分析全點位 → 寫預測日誌 → 推播",
    # 16:20 Asia/Taipei。直接宣告時區，不像 cron 版要手動換算成 UTC 08:20，
    # 日光節約時間與時區變更由 Airflow 處理。
    schedule="20 16 * * *",
    start_date=pendulum.datetime(2026, 7, 3, tz=TAIPEI),
    # 關掉補跑：Open-Meteo 只供應「未來」預報，補跑過去某天會拿到今天的
    # 預報、卻寫進那一天的列 —— point-in-time 日誌會被汙染成事後諸葛。
    # 這條管線的正確行為是漏掉就漏掉，不是補。
    catchup=False,
    # 對應 Actions 版的 concurrency group：日誌是 append-only，
    # 兩個 run 同時寫會交錯出難以還原的順序。
    max_active_runs=1,
    tags=["sunset", "forecast", "taiwan"],
    doc_md=__doc__,
)
def sunset_daily() -> None:
    @task(retries=3, retry_delay=timedelta(minutes=2))
    def fetch_and_score(front: bool = False) -> dict:
        """分析全部點位並組出廣播文字。

        重量級 import 放在任務內：DAG 檔會被 scheduler 反覆 parse，
        頂層 import sunset 會讓每次 parse 都去載整個套件。
        """
        from airflow.operators.python import get_current_context

        from sunset import pipeline

        context = get_current_context()
        # 用 data_interval_end 而不是 logical_date：日排程在 D 日 16:20 觸發的
        # run，其 logical_date 是 D-1 16:20（Airflow 的區間語意）。這條管線預測
        # 的是「觸發當下那天」的日落，不是回填某個歷史區間，所以要取區間結尾。
        target_date = context["data_interval_end"].in_timezone(TAIPEI).date()

        results = pipeline.analyze_all(target_date, front=front)
        return {
            "target_date": target_date.isoformat(),
            "text": pipeline.daily_push_text(results, target_date),
            # XCom 走 JSON，datetime/date 需先轉字串。點位數量是數十筆等級，
            # payload 很小；若日後點位暴增，這裡要改走物件儲存而非 XCom。
            "records": pipeline.records_to_payload(pipeline.prediction_records(results)),
        }

    @task(retries=0)
    def write_logbook(scored: dict) -> int:
        """把預測列 append 進 predictions.csv，回傳寫入筆數。

        retries=0 是刻意的，原因見 module docstring。
        """
        from sunset import pipeline

        records = pipeline.payload_to_records(scored["records"])
        written = pipeline.write_predictions(records)
        print(f"{scored['target_date']}：寫入 {written} 列預測")
        return written

    @task(retries=2, retry_delay=timedelta(minutes=1))
    def broadcast(scored: dict) -> list[str]:
        """推播到所有已設定通道，回傳成功的通道名。

        未設定任何通道時回傳空 list 並視為成功 —— 自架者沒有 Telegram／ntfy
        也應該能跑完整條管線，推播是選配而不是必要條件。
        """
        from sunset import pipeline

        sent = pipeline.send(scored["text"])
        print(f"已推播：{'、'.join(sent) if sent else '（未設定通道，略過）'}")
        return sent

    scored = fetch_and_score()
    write_logbook(scored)
    broadcast(scored)


sunset_daily()
