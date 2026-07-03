"""預測／結果日誌（point-in-time 紀律，硬性要求）。

- predictions.csv：預測寫入後永不修改（append-only）；同一天多次預測允許多列，
  以 predicted_at_utc 區分。校準時只用「當日最後一次 16:20 前後的預測」對 outcome。
- outcomes.csv：實際結果回報（A|B|C|D），是持續性加成的資料來源（歷史教訓 4：
  用昨日的實際回報，不是預測）。
- engine_version 從 v1.0.0 起算，任何規則常數變動都要 bump。
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path

DEFAULT_LOGS_DIR = Path(__file__).resolve().parents[2] / "data" / "logs"
PREDICTIONS_FILENAME = "predictions.csv"
OUTCOMES_FILENAME = "outcomes.csv"

PREDICTIONS_HEADER = [
    "predicted_at_utc",
    "target_date",
    "viewpoint_id",
    "cloud_low",
    "cloud_mid",
    "cloud_high",
    "visibility",
    "precip_prob",
    "rain_recent_flag",
    "burned_yesterday_flag",
    "front_flag",
    "prob_A",
    "prob_B",
    "prob_C",
    "prob_D",
    "verdict",
    "engine_version",
]

OUTCOMES_HEADER = [
    "target_date",
    "reported_at_utc",
    "outcome",
    "viewpoint_id",
    "note",
]

VALID_OUTCOMES = ("A", "B", "C", "D")
BURN_OUTCOMES = ("C", "D")  # 視為「有燒」的結果


@dataclass(frozen=True)
class PredictionRecord:
    predicted_at_utc: datetime
    target_date: date
    viewpoint_id: str
    cloud_low: float | None
    cloud_mid: float | None
    cloud_high: float | None
    visibility: float | None
    precip_prob: float | None
    rain_recent_flag: bool
    burned_yesterday_flag: bool
    front_flag: bool
    prob_a: float
    prob_b: float
    prob_c: float
    prob_d: float
    verdict: str
    engine_version: str


@dataclass(frozen=True)
class OutcomeRecord:
    target_date: date
    reported_at_utc: datetime
    outcome: str  # A|B|C|D
    viewpoint_id: str
    note: str = ""


def _fmt(value: float | None) -> str:
    return "" if value is None else f"{value:.1f}"


def _append_row(path: Path, header: list[str], row: list[str]) -> None:
    """Append-only 寫入：只以附加模式開檔，絕不覆寫既有列。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    write_header = not path.exists() or path.stat().st_size == 0
    with path.open("a", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        if write_header:
            writer.writerow(header)
        writer.writerow(row)


def append_prediction(record: PredictionRecord, logs_dir: Path | None = None) -> Path:
    """寫入一列預測（append-only；同日多次預測皆保留）。"""
    path = (logs_dir or DEFAULT_LOGS_DIR) / PREDICTIONS_FILENAME
    _append_row(
        path,
        PREDICTIONS_HEADER,
        [
            record.predicted_at_utc.astimezone(UTC).isoformat(),
            record.target_date.isoformat(),
            record.viewpoint_id,
            _fmt(record.cloud_low),
            _fmt(record.cloud_mid),
            _fmt(record.cloud_high),
            _fmt(record.visibility),
            _fmt(record.precip_prob),
            str(int(record.rain_recent_flag)),
            str(int(record.burned_yesterday_flag)),
            str(int(record.front_flag)),
            f"{record.prob_a:.1f}",
            f"{record.prob_b:.1f}",
            f"{record.prob_c:.1f}",
            f"{record.prob_d:.1f}",
            record.verdict,
            record.engine_version,
        ],
    )
    return path


def append_outcome(record: OutcomeRecord, logs_dir: Path | None = None) -> Path:
    """寫入一列實際結果回報（append-only）。"""
    if record.outcome not in VALID_OUTCOMES:
        raise ValueError(f"outcome 必須是 {VALID_OUTCOMES} 之一，收到 {record.outcome!r}")
    path = (logs_dir or DEFAULT_LOGS_DIR) / OUTCOMES_FILENAME
    _append_row(
        path,
        OUTCOMES_HEADER,
        [
            record.target_date.isoformat(),
            record.reported_at_utc.astimezone(UTC).isoformat(),
            record.outcome,
            record.viewpoint_id,
            record.note,
        ],
    )
    return path


def read_predictions(logs_dir: Path | None = None) -> list[dict[str, str]]:
    path = (logs_dir or DEFAULT_LOGS_DIR) / PREDICTIONS_FILENAME
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def read_outcomes(logs_dir: Path | None = None) -> list[dict[str, str]]:
    path = (logs_dir or DEFAULT_LOGS_DIR) / OUTCOMES_FILENAME
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def burned_on(target_date: date, logs_dir: Path | None = None) -> bool:
    """該日是否有任何點位實際回報 C 或 D（持續性加成的資料來源）。"""
    return any(
        row["target_date"] == target_date.isoformat() and row["outcome"] in BURN_OUTCOMES
        for row in read_outcomes(logs_dir)
    )
