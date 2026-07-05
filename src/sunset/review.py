"""週報：回顧過去 7 天的預測 vs 實際回報 + 未來展望。

紀律：
- 回顧配對用「當日最後一次預測」對 outcome（point-in-time）。
- 樣本 <60 天只做觀察陳述，不做任何自動調參（Phase 2 門檻）。
- 未來展望一律標註初步、信心低（歷史教訓 5）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from sunset import logbook
from sunset.analysis import VERDICT_GO, AnalysisResult
from sunset.logbook import BURN_OUTCOMES
from sunset.scoring import prob_interval

REVIEW_DAYS = 7
# 自動調參門檻（Phase 2）；未達門檻週報只觀察不調參
CALIBRATION_MIN_DAYS = 60


@dataclass(frozen=True)
class DayReview:
    """單日回顧：當日最後一次預測 vs 實際回報。"""

    target_date: date
    predicted_cd: float | None  # 最後一次預測的 C+D
    verdict: str | None
    outcome: str | None  # A|B|C|D，未回報為 None

    @property
    def burned(self) -> bool | None:
        if self.outcome is None:
            return None
        return self.outcome in BURN_OUTCOMES


@dataclass(frozen=True)
class WeeklyStats:
    start_date: date
    end_date: date
    days: tuple[DayReview, ...]

    @property
    def predicted_days(self) -> list[DayReview]:
        return [d for d in self.days if d.predicted_cd is not None]

    @property
    def reported_days(self) -> list[DayReview]:
        return [d for d in self.days if d.outcome is not None]

    @property
    def burned_days(self) -> list[DayReview]:
        return [d for d in self.days if d.burned]


def build_weekly_stats(end_date: date, logs_dir: Path | None = None) -> WeeklyStats:
    """彙整 [end_date-6, end_date] 的預測與回報。"""
    predictions = logbook.read_predictions(logs_dir)
    outcomes = logbook.read_outcomes(logs_dir)
    days: list[DayReview] = []
    for offset in range(REVIEW_DAYS - 1, -1, -1):
        day = end_date - timedelta(days=offset)
        iso = day.isoformat()
        rows = [r for r in predictions if r["target_date"] == iso]
        last = max(rows, key=lambda r: r["predicted_at_utc"]) if rows else None
        outcome_rows = [o for o in outcomes if o["target_date"] == iso]
        days.append(
            DayReview(
                target_date=day,
                predicted_cd=(float(last["prob_C"]) + float(last["prob_D"])) if last else None,
                verdict=last["verdict"] if last else None,
                outcome=outcome_rows[-1]["outcome"] if outcome_rows else None,
            )
        )
    return WeeklyStats(
        start_date=end_date - timedelta(days=REVIEW_DAYS - 1),
        end_date=end_date,
        days=tuple(days),
    )


def _md(d: date) -> str:
    return f"{d.month}/{d.day}"


def format_outlook_line(result: AnalysisResult) -> str:
    if result.probs is None:
        return f"{_md(result.target_date)}：資料不足"
    lo, hi = prob_interval(result.probs.burn_level)
    return f"{_md(result.target_date)}：火燒雲 {lo}–{hi}%・{result.verdict}（{result.viewpoint.name}）"


def format_weekly_review(stats: WeeklyStats, outlooks: tuple[AnalysisResult, ...] = ()) -> str:
    """組週報訊息（繁中、區間與比例、明示樣本限制）。"""
    lines = [f"📊 火燒雲週報 {_md(stats.start_date)}–{_md(stats.end_date)}"]
    predicted = stats.predicted_days
    reported = stats.reported_days
    lines.append(f"・預測 {len(predicted)}/{REVIEW_DAYS} 天｜結果回報 {len(reported)}/{REVIEW_DAYS} 天")

    missing = [d for d in stats.days if d.predicted_cd is not None and d.outcome is None]
    if missing:
        missing_str = "、".join(_md(d.target_date) for d in missing)
        lines.append(f"・未回報：{missing_str}（記得 /report，回報才有持續性加成與校準樣本）")

    go = [d for d in stats.days if d.verdict == VERDICT_GO]
    go_reported = [d for d in go if d.burned is not None]
    if go:
        burned = sum(1 for d in go_reported if d.burned)
        lines.append(f"・判定「出發」{len(go)} 天：已回報 {len(go_reported)} 天中實際有燒 {burned} 天")
    skip_reported = [d for d in stats.days if d.verdict and d.verdict != VERDICT_GO and d.burned is not None]
    missed = sum(1 for d in skip_reported if d.burned)
    if skip_reported:
        lines.append(f"・判定「跳過」且有回報 {len(skip_reported)} 天：錯過有燒 {missed} 天")

    if predicted:
        avg_cd = sum(d.predicted_cd for d in predicted if d.predicted_cd is not None) / len(predicted)
        lines.append(f"・預測 C+D 週平均 {avg_cd:.0f}%")
    if reported:
        rate = 100.0 * len(stats.burned_days) / len(reported)
        lines.append(f"・實際有燒比例 {rate:.0f}%（{len(stats.burned_days)}/{len(reported)} 回報日）")

    lines.append(f"樣本未達 {CALIBRATION_MIN_DAYS} 天：僅觀察陳述，不做調參。")

    if outlooks:
        lines.append("─ 未來展望（初步，信心低，以每日 16:20 推播為準）")
        lines.extend(format_outlook_line(r) for r in outlooks)
    return "\n".join(lines)
