"""組裝層：date × viewpoint → 完整分析結果（幾何 + 天氣 + 評分 + 時間表）。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sunset import solar
from sunset.geometry import (
    AlignmentResult,
    ObstructionResult,
    Viewpoint,
    assess_alignment,
    assess_obstruction,
)
from sunset.scoring import ScenarioProbs, ScoringInput, score
from sunset.weather import WeatherFetcher, WeatherWindow

# 判定門檻（常數化，日後校準）
VERDICT_GO_CD_MIN = 25.0  # C+D（火燒雲等級）點估 ≥ 25 → 出發
VERDICT_GO_VISIBLE_MIN = 50.0  # 且 B+C+D（看得到日落）≥ 50
# 初步展望門檻：中午前查詢（含未來日期）→ 標註信心低（歷史教訓 5）
PRELIMINARY_CUTOFF_HOUR = 12
# 對流風險：窗口降雨機率超過此值時，避開有對流排除註記的山區點位
CONVECTION_PRECIP_PROB = 30.0

VERDICT_GO = "出發"
VERDICT_SKIP = "跳過"
VERDICT_NO_DATA = "資料不足"


@dataclass(frozen=True)
class SolarInfo:
    """單日單點的太陽時間表（Asia/Taipei）。"""

    sunset_local: datetime
    sunset_azimuth_deg: float
    golden_start_local: datetime
    civil_twilight_end_local: datetime


@dataclass(frozen=True)
class AnalysisResult:
    """完整分析結果。"""

    target_date: date
    viewpoint: Viewpoint
    sun: SolarInfo
    alignment: AlignmentResult
    obstruction: ObstructionResult
    effective_sunset_local: datetime  # 扣除遮蔽提前沒入
    weather: WeatherWindow
    probs: ScenarioProbs | None  # 資料不足時為 None
    verdict: str
    preliminary: bool  # 初步展望（信心低，以當日 16:20 推播為準）
    generated_at_utc: datetime


def analyze(
    target_date: date,
    viewpoint: Viewpoint,
    fetcher: WeatherFetcher,
    *,
    burned_yesterday: bool = False,
    front_within_48h: bool = False,
    now_utc: datetime | None = None,
) -> AnalysisResult:
    """組裝單一 date × viewpoint 的完整分析。

    burned_yesterday 必須來自結果日誌的實際回報（歷史教訓 4）；
    front_within_48h 為 Phase 0 人工 flag。
    """
    now = now_utc or datetime.now(UTC)
    now_taipei = now.astimezone(solar.TAIPEI_TZ)

    sun = SolarInfo(
        sunset_local=solar.sunset_time(target_date, viewpoint.lat, viewpoint.lon),
        sunset_azimuth_deg=solar.sunset_azimuth(target_date, viewpoint.lat, viewpoint.lon),
        golden_start_local=solar.golden_hour_start(target_date, viewpoint.lat, viewpoint.lon),
        civil_twilight_end_local=solar.civil_twilight_end(
            target_date, viewpoint.lat, viewpoint.lon
        ),
    )
    alignment = assess_alignment(viewpoint, sun.sunset_azimuth_deg)
    obstruction = assess_obstruction(viewpoint, sun.sunset_azimuth_deg)
    effective_sunset = sun.sunset_local - timedelta(minutes=obstruction.early_minutes)

    weather = fetcher.fetch(target_date, viewpoint.lat, viewpoint.lon)

    probs: ScenarioProbs | None = None
    if weather.ok:
        probs = score(
            ScoringInput(
                cloud_low=weather.cloud_low or 0.0,
                cloud_mid=weather.cloud_mid or 0.0,
                cloud_high=weather.cloud_high or 0.0,
                precip_prob_evening=weather.precip_prob_evening or 0.0,
                burned_yesterday=burned_yesterday,
                rain_clearing=weather.rain_recent_flag,
                front_within_48h=front_within_48h,
            )
        )

    if probs is None:
        verdict = VERDICT_NO_DATA
    elif alignment.level == "警告":
        verdict = VERDICT_SKIP
    elif probs.burn_level >= VERDICT_GO_CD_MIN and probs.sunset_visible >= VERDICT_GO_VISIBLE_MIN:
        verdict = VERDICT_GO
    else:
        verdict = VERDICT_SKIP

    # 歷史教訓 5：早上的預報對午後對流幾乎無鑑別力
    preliminary = now_taipei.date() < target_date or (
        now_taipei.date() == target_date and now_taipei.hour < PRELIMINARY_CUTOFF_HOUR
    )

    return AnalysisResult(
        target_date=target_date,
        viewpoint=viewpoint,
        sun=sun,
        alignment=alignment,
        obstruction=obstruction,
        effective_sunset_local=effective_sunset,
        weather=weather,
        probs=probs,
        verdict=verdict,
        preliminary=preliminary,
        generated_at_utc=now,
    )


def recommend(results: list[AnalysisResult]) -> AnalysisResult | None:
    """從多個點位的分析中推薦一個。

    規則：排除對位警告；對流風險日（窗口降雨機率高）優先平地／河濱點位
    （尊重點位的 weather_exclusion 註記）；其餘取火燒雲等級（C+D）最高者。
    """
    candidates = [r for r in results if r.probs is not None and r.alignment.level != "警告"]
    if not candidates:
        return None

    def sort_key(r: AnalysisResult) -> tuple[float, float]:
        assert r.probs is not None
        penalty = 0.0
        precip = r.weather.precip_prob_window or 0.0
        if r.viewpoint.weather_exclusion and precip > CONVECTION_PRECIP_PROB:
            penalty = 100.0  # 對流風險日避開有排除註記的點位
        return (-penalty, r.probs.burn_level)

    return max(candidates, key=sort_key)
