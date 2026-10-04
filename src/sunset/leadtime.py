"""預測時效（lead time）：一筆預測是否在日落前「夠早」發出。

為何需要：GitHub Actions 的 schedule 觸發會大幅延遲（2026-07～10 實測：
daily-forecast 中位數晚 2.9 小時、近期常晚 5–8 小時），「16:20 預測」實際
多在 21:00–01:00 才跑。日落後才產生的「預測」用到的是已經發生時段的天氣
資料（look-ahead），拿去校準會讓模型看起來比實際準 —— 這比沒有資料更糟。

規則：發布時間距該點日落 ≥ MIN_LEAD_MINUTES 才算有效預測。
- 寫入端（pipeline.prediction_records）：逾時預測一律不寫。
- 讀取端（review / app 週報）：忽略既有的逾時列。append-only 日誌不改寫，
  只在讀取時過濾，原始紀錄保留可稽核。
- 排程端（forecast_target_date）：觸發太晚時改預測明天，讓遲到的 run 仍有用。

60 分鐘的理由：評估窗口是「日落整點前後各一小時」，且出發到點位通常要
半小時以上；晚於日落前一小時發出的判定，對「去不去」已無決策價值。
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta

from sunset import solar

MIN_LEAD_MINUTES = 60

# 讀取端遇到未建檔點位（舊列、測試列）時的參考座標：台北市中心。
# 台灣本島＋澎湖日落差不到 15 分鐘，相對 60 分鐘門檻可接受。
REF_LAT = 25.0330
REF_LON = 121.5654


def lead_minutes(predicted_at_utc: datetime, target_date: date, lat: float, lon: float) -> float:
    """發布時間距該點日落還有幾分鐘（負值＝日落後才發）。"""
    sunset = solar.sunset_time(target_date, lat, lon)
    return (sunset - predicted_at_utc).total_seconds() / 60.0


def is_timely(predicted_at_utc: datetime, target_date: date, lat: float, lon: float) -> bool:
    return lead_minutes(predicted_at_utc, target_date, lat, lon) >= MIN_LEAD_MINUTES


def row_is_timely(row: dict[str, str], coords: dict[str, tuple[float, float]]) -> bool:
    """predictions.csv 的一列是否為有效預測（讀取端過濾用）。解析失敗視為無效。"""
    try:
        at = datetime.fromisoformat(row["predicted_at_utc"])
        if at.tzinfo is None:
            at = at.replace(tzinfo=UTC)
        target = date.fromisoformat(row["target_date"])
    except (KeyError, ValueError):
        return False
    lat, lon = coords.get(row.get("viewpoint_id", ""), (REF_LAT, REF_LON))
    return is_timely(at, target, lat, lon)


def forecast_target_date(now_utc: datetime, points: Iterable[tuple[float, float]]) -> date:
    """排程觸發時該預測哪一天。

    今天距「最早日落的點位」還有 ≥ MIN_LEAD_MINUTES → 今天；否則 → 明天。
    以最早日落為準，整批點位同一天，避免一半今天一半明天。
    """
    today = now_utc.astimezone(solar.TAIPEI_TZ).date()
    coords = list(points) or [(REF_LAT, REF_LON)]
    earliest = min(solar.sunset_time(today, lat, lon) for lat, lon in coords)
    if now_utc <= earliest - timedelta(minutes=MIN_LEAD_MINUTES):
        return today
    return today + timedelta(days=1)
