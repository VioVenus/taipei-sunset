"""analysis.py / telegram_io.py 測試：組裝、判定、訊息格式、日期解析。"""

from dataclasses import replace
from datetime import UTC, date, datetime

import pytest

from sunset import telegram_io
from sunset.analysis import (
    VERDICT_GO,
    VERDICT_NO_DATA,
    VERDICT_SKIP,
    analyze,
    recommend,
)
from sunset.geometry import load_viewpoints
from sunset.weather import WeatherWindow

TARGET = date(2026, 7, 4)
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


AFTERNOON = datetime(2026, 7, 4, 8, 20, tzinfo=UTC)  # 台北 16:20


def test_analyze_ideal_go():
    result = analyze(
        TARGET, VIEWPOINTS["jiantan_laodifang"], _StubFetcher(_window()), now_utc=AFTERNOON
    )
    assert result.verdict == VERDICT_GO
    assert result.probs is not None
    assert not result.preliminary
    assert result.alignment.level == "良好"


def test_analyze_death_skip():
    window = _window(cloud_low=85.0, precip_prob_evening=70.0)
    result = analyze(
        TARGET, VIEWPOINTS["jiantan_laodifang"], _StubFetcher(window), now_utc=AFTERNOON
    )
    assert result.verdict == VERDICT_SKIP


def test_analyze_no_data_degrades():
    window = WeatherWindow(target_date=TARGET, source="stub", ok=False, error="API 失敗")
    result = analyze(
        TARGET, VIEWPOINTS["jiantan_laodifang"], _StubFetcher(window), now_utc=AFTERNOON
    )
    assert result.verdict == VERDICT_NO_DATA
    assert result.probs is None
    text = telegram_io.format_analysis(result)
    assert "資料不足" in text


def test_preliminary_flag_morning_and_future():
    """歷史教訓 5：中午前查詢（或查未來日期）標註初步展望。"""
    morning = datetime(2026, 7, 4, 1, 0, tzinfo=UTC)  # 台北 09:00 當日
    result = analyze(
        TARGET, VIEWPOINTS["jiantan_laodifang"], _StubFetcher(_window()), now_utc=morning
    )
    assert result.preliminary
    assert telegram_io.PRELIMINARY_NOTE.split("，")[0].lstrip("📌 ") in telegram_io.format_analysis(result)

    day_before = datetime(2026, 7, 3, 10, 0, tzinfo=UTC)
    result2 = analyze(
        TARGET, VIEWPOINTS["jiantan_laodifang"], _StubFetcher(_window()), now_utc=day_before
    )
    assert result2.preliminary


def test_effective_sunset_earlier_with_obstruction():
    """大稻埕：觀音山稜線 2.0° → 有效日落提前約 9.5 分鐘。"""
    result = analyze(
        TARGET, VIEWPOINTS["dadaocheng_wharf"], _StubFetcher(_window()), now_utc=AFTERNOON
    )
    early_min = (result.sun.sunset_local - result.effective_sunset_local).total_seconds() / 60
    assert early_min == pytest.approx(9.52, abs=0.2)


def test_recommend_convection_prefers_riverside():
    """對流風險日（窗口降雨機率高）→ 避開有 weather_exclusion 的山區點位。"""
    window = _window(precip_prob_window=45.0, precip_prob_evening=40.0)
    results = [
        analyze(TARGET, vp, _StubFetcher(window), now_utc=AFTERNOON)
        for vp in VIEWPOINTS.values()
    ]
    best = recommend(results)
    assert best is not None
    assert best.viewpoint.id == "dadaocheng_wharf"


def test_recommend_none_when_all_no_data():
    window = WeatherWindow(target_date=TARGET, source="stub", ok=False, error="fail")
    results = [
        analyze(TARGET, vp, _StubFetcher(window), now_utc=AFTERNOON)
        for vp in VIEWPOINTS.values()
    ]
    assert recommend(results) is None


def test_format_analysis_interval_not_point():
    """機率一律區間輸出，不出現單點假精確。"""
    result = analyze(
        TARGET, VIEWPOINTS["jiantan_laodifang"], _StubFetcher(_window()), now_utc=AFTERNOON
    )
    text = telegram_io.format_analysis(result)
    assert "–" in text  # 區間連字符
    assert "看得到日落：" in text
    assert "火燒雲：" in text
    assert "理由：" in text


def test_format_daily_push_mentions_other_viewpoints():
    results = [
        analyze(TARGET, vp, _StubFetcher(_window()), now_utc=AFTERNOON)
        for vp in VIEWPOINTS.values()
    ]
    best = recommend(results)
    assert best is not None
    text = telegram_io.format_daily_push(best, results)
    assert "其他點位" in text


def test_daily_push_region_summary():
    """全台化推播：頭條 + 各區最佳一行一區摘要，涵蓋北中南東離島。"""
    results = [
        analyze(TARGET, vp, _StubFetcher(_window()), now_utc=AFTERNOON)
        for vp in VIEWPOINTS.values()
    ]
    headline = recommend(results)
    assert headline is not None
    text = telegram_io.format_daily_push(headline, results)
    assert "全台各區最佳" in text
    for region in ("北", "中", "南", "東", "離島"):
        assert f"　{region}｜" in text


def test_parse_date_arg():
    today = date(2026, 7, 4)
    assert telegram_io.parse_date_arg("今天", today) == today
    assert telegram_io.parse_date_arg("明天", today) == date(2026, 7, 5)
    assert telegram_io.parse_date_arg("後天", today) == date(2026, 7, 6)
    assert telegram_io.parse_date_arg("2026-07-07", today) == date(2026, 7, 7)
    with pytest.raises(ValueError):
        telegram_io.parse_date_arg("2026-07-08", today)  # 超過未來 3 天
    with pytest.raises(ValueError):
        telegram_io.parse_date_arg("2026-07-03", today)  # 過去日期


def test_weather_exclusion_shown_for_jiantan():
    result = analyze(
        TARGET, VIEWPOINTS["jiantan_laodifang"], _StubFetcher(_window()), now_utc=AFTERNOON
    )
    text = telegram_io.format_analysis(result)
    assert "對流活躍日避開" in text


def test_alignment_warning_forces_skip():
    vp = replace(VIEWPOINTS["jiantan_laodifang"], open_azimuth_range=(80.0, 120.0))
    result = analyze(TARGET, vp, _StubFetcher(_window()), now_utc=AFTERNOON)
    assert result.verdict == VERDICT_SKIP
