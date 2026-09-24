"""pipeline.py 測試：編排層行為，以及跨任務傳遞的序列化邊界。

重點在 records_to_payload / payload_to_records —— 這一對只有在管線被拆成
多個行程（Airflow 任務之間走 XCom）時才會用到，CLI 路徑不經過它們，
所以沒有測試就等於沒人檢查。
"""

import json
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path

from sunset import logbook, pipeline
from sunset.analysis import VERDICT_NO_DATA, analyze
from sunset.geometry import load_viewpoints
from sunset.weather import WeatherWindow

TARGET = date(2026, 7, 4)
AFTERNOON = datetime(2026, 7, 4, 8, 20, tzinfo=UTC)  # 台北 16:20
VIEWPOINTS = load_viewpoints()


class _StubFetcher:
    source_name = "stub"

    def __init__(self, window: WeatherWindow):
        self._window = window

    def fetch(self, target_date, lat, lon):
        return self._window


def _window(**kwargs) -> WeatherWindow:
    defaults = dict(
        target_date=TARGET,
        source="stub",
        ok=True,
        cloud_low=18.0,
        cloud_mid=35.0,
        cloud_high=52.0,
        cloud_total=60.0,
        visibility_m=21000.0,
        precip_prob_window=15.0,
        precip_prob_evening=20.0,
        precip_window_mm=0.0,
        rain_recent_flag=False,
        fetched_at_utc=datetime.now(UTC),
    )
    defaults.update(kwargs)
    return WeatherWindow(**defaults)


def _analyze(window: WeatherWindow, viewpoint_id="jiantan_laodifang"):
    return analyze(TARGET, VIEWPOINTS[viewpoint_id], _StubFetcher(window), now_utc=AFTERNOON)


def _record(**kwargs) -> logbook.PredictionRecord:
    defaults = dict(
        predicted_at_utc=datetime(2026, 7, 4, 8, 20, tzinfo=UTC),
        target_date=TARGET,
        viewpoint_id="jiantan_laodifang",
        cloud_low=18.0,
        cloud_mid=35.0,
        cloud_high=52.0,
        visibility=21000.0,
        precip_prob=20.0,
        rain_recent_flag=True,
        burned_yesterday_flag=False,
        front_flag=False,
        prob_a=25.0,
        prob_b=30.0,
        prob_c=30.0,
        prob_d=15.0,
        verdict="出發",
        engine_version="v1.0.0",
    )
    defaults.update(kwargs)
    return logbook.PredictionRecord(**defaults)


# ── 序列化邊界 ────────────────────────────────────────────────────


def test_payload_roundtrip_preserves_records():
    """records → payload → records 必須完全還原，包含 datetime 的時區。"""
    records = [_record(), _record(viewpoint_id="other", prob_d=80.0)]
    restored = pipeline.payload_to_records(pipeline.records_to_payload(records))
    assert restored == records


def test_payload_is_json_serialisable():
    """XCom 預設走 JSON；payload 內不得殘留 datetime/date 物件。"""
    payload = pipeline.records_to_payload([_record()])
    encoded = json.dumps(payload)  # 會拋 TypeError 就是有東西沒轉成字串
    assert json.loads(encoded) == payload
    assert payload[0]["target_date"] == "2026-07-04"
    assert payload[0]["predicted_at_utc"].startswith("2026-07-04T08:20")


def test_payload_none_fields_survive_roundtrip():
    """天氣欄位可能是 None（資料缺漏），不能在序列化時被轉成 0 或字串。"""
    records = [_record(cloud_low=None, visibility=None, precip_prob=None)]
    restored = pipeline.payload_to_records(pipeline.records_to_payload(records))
    assert restored[0].cloud_low is None
    assert restored[0].visibility is None
    assert restored[0].precip_prob is None


# ── 編排行為 ──────────────────────────────────────────────────────


def test_write_predictions_returns_count_and_appends(tmp_path: Path):
    """回傳寫入筆數；重跑是 append 而非覆蓋（append-only）。"""
    records = [_record(), _record(viewpoint_id="second")]
    assert pipeline.write_predictions(records, tmp_path) == 2
    assert len(logbook.read_predictions(tmp_path)) == 2

    # 重跑同一批 → 變成 4 列。這正是 DAG 裡 write_logbook 設 retries=0 的理由。
    assert pipeline.write_predictions(records, tmp_path) == 2
    assert len(logbook.read_predictions(tmp_path)) == 4


def test_prediction_records_skips_insufficient_data():
    """probs is None（天氣 API 失敗）的點位不進日誌，不寫猜測值。"""
    ok = _analyze(_window())
    no_data = _analyze(_window(ok=False))
    assert no_data.probs is None

    records = pipeline.prediction_records([ok, no_data])
    assert len(records) == 1
    assert records[0].viewpoint_id == ok.viewpoint.id


def test_daily_push_text_falls_back_when_all_no_data():
    """全部點位資料不足時，明示「資料不足」而不是硬擠一個推薦出來。"""
    results = [_analyze(_window(ok=False))]
    assert results[0].verdict == VERDICT_NO_DATA

    text = pipeline.daily_push_text(results, TARGET)
    assert "資料不足" in text
    assert TARGET.isoformat() in text


def test_daily_push_text_prefers_field_verified_viewpoint():
    """頭條只用已實地驗證的點位；草稿點不會被選為推薦。"""
    verified = _analyze(_window())
    draft = replace(
        _analyze(_window()),
        viewpoint=replace(verified.viewpoint, id="draft_point", needs_field_verification=True),
    )

    text = pipeline.daily_push_text([draft, verified], TARGET)
    assert "draft_point" not in text
