"""編排層：把「每日預測」流程從 CLI 參數解析中抽離，供不同排程器共用。

存在理由：`cli.py` 原本同時負責 argparse 與流程編排，外部排程器要跑同一條
管線就只剩兩條路 —— shell out 呼叫 CLI（整條管線縮成一個黑箱步驟，看不到
任務邊界），或複製一份流程邏輯（正是本專案 CI parity 檢查在擋的「兩份實作
漂移」）。抽出這層之後，GitHub Actions 與 Airflow 跑的是同一份程式碼。

本模組只做編排，不含任何業務規則：幾何在 geometry、評分在 scoring、
格式化在 telegram_io、寫檔在 logbook。

任務邊界刻意切在「分析 → 日誌 ／ 推播」：日誌是真相源（append-only、
不可重試），推播是 best-effort（可重試）。理由見 airflow/README.md。
"""

from __future__ import annotations

import os
from dataclasses import asdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from sunset import analysis as analysis_mod
from sunset import leadtime, logbook, notify, solar, telegram_io
from sunset.geometry import load_viewpoints
from sunset.weather import CWAFetcher, OpenMeteoFetcher


def analyze_all(
    target_date: date,
    *,
    front: bool = False,
    viewpoints_file: Path | None = None,
    logs_dir: Path | None = None,
    cwa_api_key: str | None = None,
) -> list[analysis_mod.AnalysisResult]:
    """分析全部已建檔點位。

    `cwa_api_key` 留 None 時退回讀環境變數 `CWA_API_KEY`（未設定＝不啟用
    CWA 交叉驗證）。CWA 查詢按縣市快取，一日一縣市一次呼叫。
    """
    viewpoints = load_viewpoints(viewpoints_file)
    fetcher = OpenMeteoFetcher()
    burned = logbook.burned_on(target_date - timedelta(days=1), logs_dir)

    key = cwa_api_key if cwa_api_key is not None else os.environ.get("CWA_API_KEY")
    cwa = CWAFetcher(key)
    cwa_cache: dict[str, analysis_mod.CWACrossCheck] = {}

    def cross_check_for(city: str) -> analysis_mod.CWACrossCheck | None:
        if city not in cwa_cache:
            cwa_cache[city] = cwa.fetch_crosscheck(target_date, city)
        result = cwa_cache[city]
        return result if result.ok else None

    return [
        analysis_mod.analyze(
            target_date,
            vp,
            fetcher,
            burned_yesterday=burned,
            front_within_48h=front,
            cross_check=cross_check_for(vp.city),
        )
        for vp in viewpoints.values()
    ]


def headline(results: list[analysis_mod.AnalysisResult]) -> analysis_mod.AnalysisResult | None:
    """每日廣播的頭條點位：優先『已實地驗證』點位（幾何可信），否則全體中推薦。"""
    verified = [r for r in results if not r.viewpoint.needs_field_verification]
    return analysis_mod.recommend(verified) or analysis_mod.recommend(results)


def daily_push_text(results: list[analysis_mod.AnalysisResult], target_date: date) -> str:
    """組每日廣播文字。

    頭條見 headline()；草稿點仍出現在各區摘要與 app。
    全部點位都資料不足時回退為明示的「資料不足」訊息，不做假精確。
    """
    recommended = headline(results)
    if recommended is None:
        return f"❓ {target_date.isoformat()} 日落判定：資料不足（天氣 API 失敗），請以現場目視為準。"
    return telegram_io.format_daily_push(recommended, results)


def prediction_records(
    results: list[analysis_mod.AnalysisResult],
) -> list[logbook.PredictionRecord]:
    """把分析結果轉成待寫入的預測列。

    略過：資料不足（probs is None）的點位，以及**逾時預測**——距該點日落不足
    leadtime.MIN_LEAD_MINUTES 才產生的結果（排程遲到時會發生），那等於拿已發生
    的天氣「預測」過去，寫進日誌會汙染校準。理由見 sunset/leadtime.py。
    """
    records: list[logbook.PredictionRecord] = []
    for r in results:
        if r.probs is None:
            continue
        vp = r.viewpoint
        if not leadtime.is_timely(r.generated_at_utc, r.target_date, vp.lat, vp.lon):
            continue
        records.append(
            logbook.PredictionRecord(
                predicted_at_utc=r.generated_at_utc,
                target_date=r.target_date,
                viewpoint_id=r.viewpoint.id,
                cloud_low=r.weather.cloud_low,
                cloud_mid=r.weather.cloud_mid,
                cloud_high=r.weather.cloud_high,
                visibility=r.weather.visibility_m,
                precip_prob=r.weather.precip_prob_evening,
                rain_recent_flag=r.weather.rain_recent_flag,
                burned_yesterday_flag=any("昨日實際有燒" in reason for reason in r.probs.reasons),
                front_flag=any("鋒面" in reason for reason in r.probs.reasons),
                prob_a=r.probs.a,
                prob_b=r.probs.b,
                prob_c=r.probs.c,
                prob_d=r.probs.d,
                verdict=r.verdict,
                engine_version=r.probs.engine_version,
            )
        )
    return records


def write_predictions(
    records: list[logbook.PredictionRecord], logs_dir: Path | None = None
) -> int:
    """寫入預測列，回傳寫入筆數。

    append-only：同一天重跑會多出一批列而不是覆蓋。這是刻意的（predictions.csv
    是 point-in-time 紀錄，用來事後校準模型），代價是**這一步不可重試** ——
    排程器上的 retry 會製造重複列。
    """
    for record in records:
        logbook.append_prediction(record, logs_dir)
    return len(records)


def log_predictions(
    results: list[analysis_mod.AnalysisResult], logs_dir: Path | None = None
) -> int:
    """analyze → 寫日誌的便捷組合（CLI 用）。"""
    return write_predictions(prediction_records(results), logs_dir)


# ── 多重觸發下的去重與推播節制 ──────────────────────────────────
# GitHub 排程會遲到數小時，所以一天排了多個時段＋（選用）Cloudflare 準點觸發。
# 下面兩個規則讓「多觸發」不變成「多推播」。

# 同一目標日在這段時間內已有有效預測 → 本次觸發視為重複，整個略過
DEDUPE_MINUTES = 90
# 台北時間這段時間內只寫日誌不推播（遲到的 run 不要半夜吵人）
QUIET_HOURS = (23, 8)  # [23:00, 08:00)


def timely_rows_for(
    target_date: date, coords: dict[str, tuple[float, float]], logs_dir: Path | None = None
) -> list[dict[str, str]]:
    """日誌中該目標日的有效（非逾時）預測列。"""
    iso = target_date.isoformat()
    return [
        r
        for r in logbook.read_predictions(logs_dir)
        if r["target_date"] == iso and leadtime.row_is_timely(r, coords)
    ]


def _issued_at(row: dict[str, str]) -> datetime:
    at = datetime.fromisoformat(row["predicted_at_utc"])
    return at if at.tzinfo else at.replace(tzinfo=UTC)


def is_duplicate_trigger(now_utc: datetime, prior: list[dict[str, str]]) -> bool:
    """稍早（DEDUPE_MINUTES 內）已有同目標日的有效預測 → 這次觸發是重複的。"""
    if not prior:
        return False
    latest = max(_issued_at(r) for r in prior)
    return now_utc - latest < timedelta(minutes=DEDUPE_MINUTES)


def push_decision(
    now_utc: datetime,
    prior: list[dict[str, str]],
    head: analysis_mod.AnalysisResult | None,
) -> str:
    """這次要不要推播：quiet（夜間）／first（當日首推）／changed（頭條判定變了）／unchanged。"""
    hour = now_utc.astimezone(solar.TAIPEI_TZ).hour
    start, end = QUIET_HOURS
    if hour >= start or hour < end:
        return "quiet"
    if not prior:
        return "first"
    if head is None:
        return "unchanged"  # 稍早已推過，資料不足不再重複打擾
    same_point = [r for r in prior if r["viewpoint_id"] == head.viewpoint.id]
    if not same_point:
        return "changed"  # 頭條換了點位
    last = max(same_point, key=_issued_at)
    return "unchanged" if last["verdict"] == head.verdict else "changed"


def send(text: str) -> list[str]:
    """推播到所有已設定通道，回傳成功的通道名。未設定任何通道時回傳空 list。"""
    if not notify.any_configured():
        return []
    return notify.send_push(text)


# ── XCom / 跨行程傳遞用的 JSON-safe 轉換 ─────────────────────────────
# Airflow 的 XCom 預設走 JSON 序列化，datetime/date 不在支援範圍，
# 因此分析與寫檔拆成兩個任務時，中間要過這一層。

_DT_FIELDS = ("predicted_at_utc",)
_DATE_FIELDS = ("target_date",)


def records_to_payload(records: list[logbook.PredictionRecord]) -> list[dict[str, Any]]:
    """PredictionRecord → JSON-safe dict（日期時間轉 ISO 8601 字串）。"""
    payload: list[dict[str, Any]] = []
    for record in records:
        row = asdict(record)
        for field in _DT_FIELDS + _DATE_FIELDS:
            row[field] = row[field].isoformat()
        payload.append(row)
    return payload


def payload_to_records(payload: list[dict[str, Any]]) -> list[logbook.PredictionRecord]:
    """records_to_payload 的反向；欄位不符會直接拋 TypeError，不做寬容解析。"""
    records: list[logbook.PredictionRecord] = []
    for row in payload:
        row = dict(row)
        for field in _DT_FIELDS:
            row[field] = datetime.fromisoformat(row[field])
        for field in _DATE_FIELDS:
            row[field] = date.fromisoformat(row[field])
        records.append(logbook.PredictionRecord(**row))
    return records
