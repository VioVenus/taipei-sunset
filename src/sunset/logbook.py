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

# 公開版群眾回報表：任何人透過 Issue Form 回報都落在這裡（append-only）。
# outcomes.csv 保留為擁有者/既有管道，聚合時視為 reporter="owner"。
REPORTS_FILENAME = "reports.csv"
REPORTS_HEADER = [
    "target_date",
    "reported_at_utc",
    "outcome",
    "viewpoint_id",
    "note",
    "reporter",
    "source",
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


@dataclass(frozen=True)
class ReportRecord:
    """群眾回報（一位回報者一筆；同人同日多筆只取最新）。"""

    target_date: date
    reported_at_utc: datetime
    outcome: str  # A|B|C|D
    viewpoint_id: str
    note: str
    reporter: str  # GitHub login 或 "owner"
    source: str  # 例如 "issue#12"、"app"、"cli"


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


def append_report(record: ReportRecord, logs_dir: Path | None = None) -> Path:
    """寫入一筆群眾回報（append-only）。"""
    if record.outcome not in VALID_OUTCOMES:
        raise ValueError(f"outcome 必須是 {VALID_OUTCOMES} 之一，收到 {record.outcome!r}")
    path = (logs_dir or DEFAULT_LOGS_DIR) / REPORTS_FILENAME
    _append_row(
        path,
        REPORTS_HEADER,
        [
            record.target_date.isoformat(),
            record.reported_at_utc.astimezone(UTC).isoformat(),
            record.outcome,
            record.viewpoint_id,
            record.note,
            record.reporter,
            record.source,
        ],
    )
    return path


def read_reports(logs_dir: Path | None = None) -> list[dict[str, str]]:
    path = (logs_dir or DEFAULT_LOGS_DIR) / REPORTS_FILENAME
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def all_reports(logs_dir: Path | None = None) -> list[dict[str, str]]:
    """合併回報池：outcomes.csv（視為 reporter='owner'）∪ reports.csv。"""
    merged = [
        {**row, "reporter": "owner", "source": row.get("source", "legacy")}
        for row in read_outcomes(logs_dir)
    ]
    merged.extend(read_reports(logs_dir))
    return merged


def _latest_votes(target_date: date, logs_dir: Path | None = None) -> dict[str, str]:
    """該日每位回報者的最新一票：reporter → outcome。"""
    iso = target_date.isoformat()
    votes: dict[str, tuple[str, str]] = {}  # reporter → (reported_at, outcome)
    for row in all_reports(logs_dir):
        if row["target_date"] != iso or row["outcome"] not in VALID_OUTCOMES:
            continue
        reporter = row.get("reporter") or "anonymous"
        at = row.get("reported_at_utc", "")
        if reporter not in votes or at >= votes[reporter][0]:
            votes[reporter] = (at, row["outcome"])
    return {reporter: outcome for reporter, (_, outcome) in votes.items()}


def consensus_outcome(target_date: date, logs_dir: Path | None = None) -> str | None:
    """該日共識結果字母：眾數；平手取較保守（A<B<C<D 取較前者）；無回報 → None。"""
    votes = list(_latest_votes(target_date, logs_dir).values())
    if not votes:
        return None
    counts = {o: votes.count(o) for o in VALID_OUTCOMES if o in votes}
    best = max(counts.values())
    return next(o for o in VALID_OUTCOMES if counts.get(o) == best)


def burned_on(target_date: date, logs_dir: Path | None = None) -> bool:
    """該日是否「有燒」：燒（C/D）票數 > 非燒（A/B）票數（持續性加成的資料來源）。

    多人回報時以多數決聚合，平手取保守（不算有燒）；
    單人時代表其最新回報，與單人版行為一致。
    """
    votes = _latest_votes(target_date, logs_dir).values()
    burn = sum(1 for v in votes if v in BURN_OUTCOMES)
    return burn > len(votes) - burn
