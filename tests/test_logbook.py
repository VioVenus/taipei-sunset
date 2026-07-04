"""logbook.py 測試：append-only 行為與 schema 完整性。"""

from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from sunset import logbook


def _prediction(target=date(2026, 7, 4), at=None):
    return logbook.PredictionRecord(
        predicted_at_utc=at or datetime(2026, 7, 4, 8, 20, tzinfo=UTC),
        target_date=target,
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


def test_prediction_schema_complete(tmp_path: Path):
    """欄位順序與名稱完全符合規格 schema。"""
    logbook.append_prediction(_prediction(), tmp_path)
    text = (tmp_path / "predictions.csv").read_text(encoding="utf-8")
    header = text.splitlines()[0]
    assert header == (
        "predicted_at_utc,target_date,viewpoint_id,cloud_low,cloud_mid,cloud_high,"
        "visibility,precip_prob,rain_recent_flag,burned_yesterday_flag,front_flag,"
        "prob_A,prob_B,prob_C,prob_D,verdict,engine_version"
    )
    rows = logbook.read_predictions(tmp_path)
    assert rows[0]["verdict"] == "出發"
    assert rows[0]["engine_version"] == "v1.0.0"
    assert rows[0]["prob_A"] == "25.0"


def test_predictions_append_only(tmp_path: Path):
    """既有列永不修改；同一天多次預測允許多列。"""
    logbook.append_prediction(_prediction(), tmp_path)
    first = (tmp_path / "predictions.csv").read_text(encoding="utf-8")
    logbook.append_prediction(
        _prediction(at=datetime(2026, 7, 4, 8, 25, tzinfo=UTC)), tmp_path
    )
    second = (tmp_path / "predictions.csv").read_text(encoding="utf-8")
    assert second.startswith(first)  # 舊內容原封不動
    assert len(logbook.read_predictions(tmp_path)) == 2


def test_outcome_schema_and_append(tmp_path: Path):
    logbook.append_outcome(
        logbook.OutcomeRecord(
            target_date=date(2026, 7, 4),
            reported_at_utc=datetime(2026, 7, 4, 11, 20, tzinfo=UTC),
            outcome="C",
            viewpoint_id="dadaocheng_wharf",
            note="西北側局部燒",
        ),
        tmp_path,
    )
    text = (tmp_path / "outcomes.csv").read_text(encoding="utf-8")
    assert text.splitlines()[0] == "target_date,reported_at_utc,outcome,viewpoint_id,note"
    rows = logbook.read_outcomes(tmp_path)
    assert rows[0]["outcome"] == "C"
    assert rows[0]["note"] == "西北側局部燒"


def test_outcome_invalid_rejected(tmp_path: Path):
    with pytest.raises(ValueError):
        logbook.append_outcome(
            logbook.OutcomeRecord(
                target_date=date(2026, 7, 4),
                reported_at_utc=datetime.now(UTC),
                outcome="X",
                viewpoint_id="",
            ),
            tmp_path,
        )


def test_burned_on_uses_actual_outcomes(tmp_path: Path):
    """持續性加成資料來源 = 實際回報（C/D 算有燒，A/B 不算）。"""
    assert not logbook.burned_on(date(2026, 7, 4), tmp_path)
    logbook.append_outcome(
        logbook.OutcomeRecord(
            target_date=date(2026, 7, 4),
            reported_at_utc=datetime.now(UTC),
            outcome="B",
            viewpoint_id="",
        ),
        tmp_path,
    )
    assert not logbook.burned_on(date(2026, 7, 4), tmp_path)
    logbook.append_outcome(
        logbook.OutcomeRecord(
            target_date=date(2026, 7, 4),
            reported_at_utc=datetime.now(UTC),
            outcome="D",
            viewpoint_id="",
        ),
        tmp_path,
    )
    assert logbook.burned_on(date(2026, 7, 4), tmp_path)
    assert not logbook.burned_on(date(2026, 7, 5), tmp_path)


def test_read_missing_files_empty(tmp_path: Path):
    assert logbook.read_predictions(tmp_path) == []
    assert logbook.read_outcomes(tmp_path) == []
