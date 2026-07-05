"""review.py 測試：週報統計與訊息格式。"""

from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from sunset import logbook, review
from sunset.analysis import analyze
from sunset.geometry import load_viewpoints
from sunset.weather import WeatherWindow

END = date(2026, 7, 5)
VIEWPOINTS = load_viewpoints()


def _add_prediction(logs_dir: Path, target: date, cd: float, verdict: str, hour: int = 8):
    logbook.append_prediction(
        logbook.PredictionRecord(
            predicted_at_utc=datetime(target.year, target.month, target.day, hour, 20, tzinfo=UTC),
            target_date=target,
            viewpoint_id="jiantan_laodifang",
            cloud_low=20.0,
            cloud_mid=40.0,
            cloud_high=50.0,
            visibility=20000.0,
            precip_prob=10.0,
            rain_recent_flag=False,
            burned_yesterday_flag=False,
            front_flag=False,
            prob_a=20.0,
            prob_b=100.0 - 20.0 - cd,
            prob_c=cd * 0.6,
            prob_d=cd * 0.4,
            verdict=verdict,
            engine_version="v1.0.0",
        ),
        logs_dir,
    )


def _add_outcome(logs_dir: Path, target: date, outcome: str):
    logbook.append_outcome(
        logbook.OutcomeRecord(
            target_date=target,
            reported_at_utc=datetime(target.year, target.month, target.day, 11, 20, tzinfo=UTC),
            outcome=outcome,
            viewpoint_id="",
        ),
        logs_dir,
    )


def test_weekly_stats_pairing(tmp_path: Path):
    """每日取最後一次預測；outcome 取最後一筆回報。"""
    d = END - timedelta(days=1)
    _add_prediction(tmp_path, d, cd=30.0, verdict="跳過", hour=2)  # 早上初步
    _add_prediction(tmp_path, d, cd=55.0, verdict="出發", hour=8)  # 16:20 最終
    _add_outcome(tmp_path, d, "C")
    stats = review.build_weekly_stats(END, tmp_path)
    day = next(x for x in stats.days if x.target_date == d)
    assert day.predicted_cd == pytest.approx(55.0)
    assert day.verdict == "出發"
    assert day.outcome == "C"
    assert day.burned is True
    assert len(stats.days) == 7
    assert stats.start_date == END - timedelta(days=6)


def test_weekly_stats_empty_logs(tmp_path: Path):
    stats = review.build_weekly_stats(END, tmp_path)
    assert len(stats.days) == 7
    assert stats.predicted_days == []
    assert stats.reported_days == []
    text = review.format_weekly_review(stats)
    assert "週報" in text
    assert "不做調參" in text


def test_weekly_review_message(tmp_path: Path):
    _add_prediction(tmp_path, END - timedelta(days=2), cd=60.0, verdict="出發")
    _add_outcome(tmp_path, END - timedelta(days=2), "D")
    _add_prediction(tmp_path, END - timedelta(days=1), cd=10.0, verdict="跳過")
    _add_outcome(tmp_path, END - timedelta(days=1), "C")  # 錯過
    _add_prediction(tmp_path, END, cd=40.0, verdict="出發")  # 未回報
    stats = review.build_weekly_stats(END, tmp_path)
    text = review.format_weekly_review(stats)
    assert "預測 3/7 天｜結果回報 2/7 天" in text
    assert "「出發」2 天：已回報 1 天中實際有燒 1 天" in text
    assert "錯過有燒 1 天" in text
    assert "未回報：7/5" in text
    assert "不做調參" in text


def test_weekly_review_with_outlook(tmp_path: Path):
    class StubFetcher:
        source_name = "stub"

        def fetch(self, target_date, lat, lon):
            return WeatherWindow(
                target_date=target_date,
                source="stub",
                ok=True,
                cloud_low=15.0,
                cloud_mid=40.0,
                cloud_high=50.0,
                cloud_total=55.0,
                visibility_m=20000.0,
                precip_prob_window=10.0,
                precip_prob_evening=10.0,
                precip_window_mm=0.0,
                rain_recent_flag=False,
                fetched_at_utc=datetime.now(UTC),
            )

    outlook = analyze(
        END + timedelta(days=1),
        VIEWPOINTS["jiantan_laodifang"],
        StubFetcher(),
        now_utc=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
    )
    stats = review.build_weekly_stats(END, tmp_path)
    text = review.format_weekly_review(stats, (outlook,))
    assert "未來展望（初步，信心低" in text
    assert "7/6：火燒雲" in text
    assert "–" in text  # 區間輸出
