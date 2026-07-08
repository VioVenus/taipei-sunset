"""動態不確定性區間 + 多模式集成 + CWA 交叉驗證測試。"""

from datetime import UTC, date, datetime

import pytest

from sunset import telegram_io
from sunset.analysis import analyze
from sunset.geometry import load_viewpoints
from sunset.scoring import dynamic_half_width, prob_interval
from sunset.weather import CWACrossCheck, CWAFetcher, OpenMeteoFetcher, WeatherWindow

TARGET = date(2026, 7, 4)
VIEWPOINTS = load_viewpoints()
AFTERNOON = datetime(2026, 7, 4, 8, 20, tzinfo=UTC)


# ── 動態半寬 ─────────────────────────────────────────────
def test_dynamic_half_width():
    assert dynamic_half_width(None) == 10.0  # 無集成資料 → 基準
    assert dynamic_half_width(0.0) == 10.0
    assert dynamic_half_width(10.0) == 10.0  # 門檻內不加寬
    assert dynamic_half_width(20.0) == 15.0  # 10 + 0.5*(20-10)
    assert dynamic_half_width(40.0) == 25.0  # 上限
    assert dynamic_half_width(100.0) == 25.0


def test_prob_interval_with_custom_width():
    assert prob_interval(50, 15.0) == (35, 65)
    assert prob_interval(50) == (40, 60)  # 預設不變
    assert prob_interval(90, 25.0) == (65, 100)  # 夾在 [0,100]


# ── 集成分歧解析 ──────────────────────────────────────────
def _main_payload():
    return {
        "hourly": {
            "time": [f"2026-07-04T{h:02d}:00" for h in range(24)],
            "cloud_cover_low": [20.0] * 24,
            "cloud_cover_mid": [40.0] * 24,
            "cloud_cover_high": [50.0] * 24,
            "cloud_cover": [60.0] * 24,
            "visibility": [20000.0] * 24,
            "precipitation_probability": [10.0] * 24,
            "precipitation": [0.0] * 24,
        }
    }


def _ensemble_payload(icon_high=70.0, gfs_high=30.0):
    hourly = {"time": [f"2026-07-04T{h:02d}:00" for h in range(24)]}
    for model, high in (("icon_seamless", icon_high), ("gfs_seamless", gfs_high)):
        hourly[f"cloud_cover_low_{model}"] = [20.0] * 24
        hourly[f"cloud_cover_mid_{model}"] = [40.0] * 24
        hourly[f"cloud_cover_high_{model}"] = [high] * 24
    return {"hourly": hourly}


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _TwoCallSession:
    """第一次回主預報，第二次回集成；可設定第二次失敗。"""

    def __init__(self, ensemble_payload=None, ensemble_fails=False):
        self.calls = 0
        self._ensemble = ensemble_payload
        self._fails = ensemble_fails

    def get(self, url, params=None, timeout=None):
        self.calls += 1
        if "models" in (params or {}):
            if self._fails:
                raise ConnectionError("ensemble down")
            return _FakeResponse(self._ensemble)
        return _FakeResponse(_main_payload())


def test_ensemble_spread_computed():
    """best_match high=50、icon=70、gfs=30 → mid_high 分歧 = 70-40? 各模型 mid_high=max(mid,high)。

    best_match mid_high = max(40,50)=50；icon = max(40,70)=70；gfs = max(40,40... gfs high=30→40)。
    spread = 70 - 40 = 30。
    """
    session = _TwoCallSession(_ensemble_payload(icon_high=70.0, gfs_high=30.0))
    window = OpenMeteoFetcher(session=session).fetch(TARGET, 25.09, 121.54)
    assert window.ok
    assert window.model_spread == pytest.approx(30.0)
    assert "icon_seamless" in window.ensemble_models
    assert session.calls == 2


def test_ensemble_failure_degrades_to_fixed_width():
    session = _TwoCallSession(ensemble_fails=True)
    window = OpenMeteoFetcher(session=session).fetch(TARGET, 25.09, 121.54)
    assert window.ok  # 主結果不受影響
    assert window.model_spread is None
    assert dynamic_half_width(window.model_spread) == 10.0


def test_widened_interval_shown_in_message():
    class _StubFetcher:
        source_name = "stub"

        def fetch(self, target_date, lat, lon):
            return WeatherWindow(
                target_date=TARGET, source="stub", ok=True,
                cloud_low=18.0, cloud_mid=35.0, cloud_high=52.0,
                precip_prob_evening=20.0, model_spread=30.0,
                ensemble_models="best_match,icon_seamless,gfs_seamless",
                fetched_at_utc=datetime.now(UTC),
            )

    result = analyze(TARGET, VIEWPOINTS["jiantan_laodifang"], _StubFetcher(), now_utc=AFTERNOON)
    assert result.interval_half_width == pytest.approx(20.0)
    text = telegram_io.format_analysis(result)
    assert "區間加寬至 ±20" in text
    assert "多模式雲量分歧 30%" in text


# ── CWA 交叉驗證 ─────────────────────────────────────────
def _cwa_payload(pop="30", wx="多雲時晴"):
    def slots(values):
        starts = ["2026-07-04T12:00:00", "2026-07-04T18:00:00", "2026-07-05T06:00:00"]
        ends = ["2026-07-04T18:00:00", "2026-07-05T06:00:00", "2026-07-05T18:00:00"]
        return [
            {"startTime": s, "endTime": e, "parameter": {"parameterName": v}}
            for s, e, v in zip(starts, ends, values, strict=True)
        ]

    return {
        "records": {
            "location": [
                {
                    "locationName": "臺北市",
                    "weatherElement": [
                        {"elementName": "Wx", "time": slots(["晴午後短暫雷陣雨", wx, "晴時多雲"])},
                        {"elementName": "PoP", "time": slots(["40", pop, "10"])},
                    ],
                }
            ]
        }
    }


class _CWASession:
    def __init__(self, payload):
        self._payload = payload

    def get(self, url, params=None, timeout=None):
        assert params["Authorization"]
        return _FakeResponse(self._payload)


def test_cwa_crosscheck_picks_evening_slot():
    fetcher = CWAFetcher(api_key="test-key", session=_CWASession(_cwa_payload()))
    cc = fetcher.fetch_crosscheck(TARGET)
    assert cc.ok
    assert cc.wx_text == "多雲時晴"
    assert cc.pop_percent == 30.0
    assert "07/04 18時" in cc.period_label


def test_cwa_no_key_skips():
    cc = CWAFetcher(api_key=None).fetch_crosscheck(TARGET)
    assert not cc.ok and "金鑰" in (cc.error or "")


def test_cwa_disagreement_flagged_in_message():
    class _StubFetcher:
        source_name = "stub"

        def fetch(self, target_date, lat, lon):
            return WeatherWindow(
                target_date=TARGET, source="stub", ok=True,
                cloud_low=18.0, cloud_mid=35.0, cloud_high=52.0,
                precip_prob_evening=10.0, fetched_at_utc=datetime.now(UTC),
            )

    cc = CWACrossCheck(ok=True, wx_text="陰短暫雨", pop_percent=70.0, period_label="07/04 18時–06時")
    result = analyze(
        TARGET, VIEWPOINTS["jiantan_laodifang"], _StubFetcher(),
        now_utc=AFTERNOON, cross_check=cc,
    )
    text = telegram_io.format_analysis(result)
    assert "CWA 交叉驗證" in text and "陰短暫雨" in text
    assert "分歧大" in text  # |70-10| > 30


def test_cwa_agreement_no_flag():
    class _StubFetcher:
        source_name = "stub"

        def fetch(self, target_date, lat, lon):
            return WeatherWindow(
                target_date=TARGET, source="stub", ok=True,
                cloud_low=18.0, cloud_mid=35.0, cloud_high=52.0,
                precip_prob_evening=25.0, fetched_at_utc=datetime.now(UTC),
            )

    cc = CWACrossCheck(ok=True, wx_text="多雲", pop_percent=30.0, period_label="07/04 18時–06時")
    result = analyze(
        TARGET, VIEWPOINTS["jiantan_laodifang"], _StubFetcher(),
        now_utc=AFTERNOON, cross_check=cc,
    )
    text = telegram_io.format_analysis(result)
    assert "CWA 交叉驗證" in text
    assert "分歧大" not in text
