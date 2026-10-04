"""leadtime.py 測試：排程遲到時不得產生／採用「日落後的預測」。"""

from datetime import UTC, date, datetime
from pathlib import Path

from sunset import cli, leadtime, logbook, pipeline, review
from sunset.analysis import analyze
from sunset.geometry import load_viewpoints
from sunset.weather import WeatherWindow

VIEWPOINTS = load_viewpoints()
JIANTAN = VIEWPOINTS["jiantan_laodifang"]
DAY = date(2026, 10, 4)  # 台北日落約 17:40
AT_1620_TPE = datetime(2026, 10, 4, 8, 20, tzinfo=UTC)
AT_2207_TPE = datetime(2026, 10, 4, 14, 7, tzinfo=UTC)  # 實際發生過的遲到時間


def test_lead_minutes_sign():
    assert leadtime.lead_minutes(AT_1620_TPE, DAY, JIANTAN.lat, JIANTAN.lon) > 60
    assert leadtime.lead_minutes(AT_2207_TPE, DAY, JIANTAN.lat, JIANTAN.lon) < 0


def test_is_timely_threshold():
    sunset = leadtime.solar.sunset_time(DAY, JIANTAN.lat, JIANTAN.lon)
    just_ok = sunset - leadtime.timedelta(minutes=leadtime.MIN_LEAD_MINUTES)
    too_late = just_ok + leadtime.timedelta(minutes=1)
    assert leadtime.is_timely(just_ok, DAY, JIANTAN.lat, JIANTAN.lon)
    assert not leadtime.is_timely(too_late, DAY, JIANTAN.lat, JIANTAN.lon)


def test_forecast_target_switches_to_tomorrow_when_late():
    points = [(v.lat, v.lon) for v in VIEWPOINTS.values()]
    assert leadtime.forecast_target_date(AT_1620_TPE, points) == DAY
    assert leadtime.forecast_target_date(AT_2207_TPE, points) == date(2026, 10, 5)


def test_row_is_timely_handles_unknown_and_malformed_rows():
    late = {"predicted_at_utc": AT_2207_TPE.isoformat(), "target_date": "2026-10-04",
            "viewpoint_id": "no_such_point"}
    ok = dict(late, predicted_at_utc=AT_1620_TPE.isoformat())
    assert not leadtime.row_is_timely(late, {})
    assert leadtime.row_is_timely(ok, {})  # 未建檔點位退回台北參考座標
    assert not leadtime.row_is_timely({"predicted_at_utc": "garbage", "target_date": "x"}, {})


def _window() -> WeatherWindow:
    return WeatherWindow(
        target_date=DAY, source="stub", ok=True, cloud_low=18.0, cloud_mid=35.0,
        cloud_high=52.0, cloud_total=60.0, visibility_m=21000.0, precip_prob_window=15.0,
        precip_prob_evening=20.0, precip_window_mm=0.0, rain_recent_flag=False,
        fetched_at_utc=AT_1620_TPE,
    )


class _Stub:
    source_name = "stub"

    def fetch(self, target_date, lat, lon):
        return _window()


def test_prediction_records_drops_post_sunset_results():
    timely = analyze(DAY, JIANTAN, _Stub(), now_utc=AT_1620_TPE)
    late = analyze(DAY, JIANTAN, _Stub(), now_utc=AT_2207_TPE)
    assert len(pipeline.prediction_records([timely])) == 1
    assert pipeline.prediction_records([late]) == []


def _row(logs_dir: Path, at: datetime, cd: float, verdict: str) -> None:
    logbook.append_prediction(
        logbook.PredictionRecord(
            predicted_at_utc=at, target_date=DAY, viewpoint_id=JIANTAN.id,
            cloud_low=20.0, cloud_mid=40.0, cloud_high=50.0, visibility=20000.0,
            precip_prob=10.0, rain_recent_flag=False, burned_yesterday_flag=False,
            front_flag=False, prob_a=20.0, prob_b=80.0 - cd, prob_c=cd * 0.6,
            prob_d=cd * 0.4, verdict=verdict, engine_version="v1.3.0",
        ),
        logs_dir,
    )


def test_weekly_review_ignores_later_post_sunset_row(tmp_path: Path):
    """既有日誌裡較晚的日落後列（look-ahead）不得蓋過當天有效的預測。"""
    _row(tmp_path, AT_1620_TPE, cd=40.0, verdict="出發")
    _row(tmp_path, AT_2207_TPE, cd=5.0, verdict="跳過")
    stats = review.build_weekly_stats(DAY, tmp_path)
    today = stats.days[-1]
    assert today.verdict == "出發"
    assert today.predicted_cd == 40.0


def test_outcome_prompt_window():
    assert cli.outcome_prompt_due(datetime(2026, 10, 4, 11, 15, tzinfo=UTC))  # 19:15 TPE
    assert not cli.outcome_prompt_due(datetime(2026, 10, 4, 7, 0, tzinfo=UTC))  # 15:00 日落前
    assert not cli.outcome_prompt_due(datetime(2026, 10, 4, 17, 30, tzinfo=UTC))  # 01:30 半夜


# ── 多重觸發：去重與推播節制 ─────────────────────────────────────────
def _prior(at: datetime, verdict: str = "出發", vp: str = "jiantan_laodifang") -> dict[str, str]:
    return {"predicted_at_utc": at.isoformat(), "target_date": DAY.isoformat(),
            "viewpoint_id": vp, "verdict": verdict}


def test_duplicate_trigger_within_window_is_skipped():
    from datetime import timedelta
    first = AT_1620_TPE - timedelta(minutes=40)
    assert pipeline.is_duplicate_trigger(AT_1620_TPE, [_prior(first)])
    assert not pipeline.is_duplicate_trigger(AT_1620_TPE, [_prior(first - timedelta(hours=2))])
    assert not pipeline.is_duplicate_trigger(AT_1620_TPE, [])


def test_push_decision_rules():
    from datetime import timedelta
    head = analyze(DAY, JIANTAN, _Stub(), now_utc=AT_1620_TPE)
    earlier = AT_1620_TPE - timedelta(hours=3)
    assert pipeline.push_decision(AT_1620_TPE, [], head) == "first"
    assert pipeline.push_decision(AT_1620_TPE, [_prior(earlier, head.verdict)], head) == "unchanged"
    other = "跳過" if head.verdict != "跳過" else "出發"
    assert pipeline.push_decision(AT_1620_TPE, [_prior(earlier, other)], head) == "changed"
    assert pipeline.push_decision(AT_1620_TPE, [_prior(earlier, vp="xiziwan")], head) == "changed"
    late_night = datetime(2026, 10, 4, 16, 30, tzinfo=UTC)  # 00:30 TPE
    assert pipeline.push_decision(late_night, [], head) == "quiet"


def test_push_decision_ignores_quiet_hour_and_previous_day_rows():
    """夜間只寫日誌的列、前一晚的明日預覽，都不能吃掉今天白天的首推。"""
    head = analyze(DAY, JIANTAN, _Stub(), now_utc=AT_1620_TPE)
    quiet_row = _prior(datetime(2026, 10, 3, 16, 30, tzinfo=UTC), head.verdict)  # 10/4 00:30 TPE
    preview_row = _prior(datetime(2026, 10, 3, 13, 0, tzinfo=UTC), head.verdict)  # 10/3 21:00 TPE
    assert pipeline.push_decision(AT_1620_TPE, [quiet_row, preview_row], head) == "first"
