"""weather.py 測試：mock response 解析與降級路徑。"""

from datetime import date

from sunset.weather import CWAFetcher, OpenMeteoFetcher

TARGET = date(2026, 7, 4)


def _payload(precip=None, precip_prob=None):
    hours = list(range(24))
    precip = precip if precip is not None else [0.0] * 24
    precip_prob = precip_prob if precip_prob is not None else [10.0] * 24
    return {
        "hourly": {
            "time": [f"2026-07-04T{h:02d}:00" for h in hours],
            "cloud_cover_low": [20.0] * 24,
            "cloud_cover_mid": [40.0] * 24,
            "cloud_cover_high": [55.0] * 24,
            "cloud_cover": [60.0] * 24,
            "visibility": [20000.0] * 24,
            "precipitation_probability": precip_prob,
            "precipitation": precip,
        }
    }


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeSession:
    """成功回應的假 session；記錄呼叫參數。"""

    def __init__(self, payload):
        self._payload = payload
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params, timeout))
        return _FakeResponse(self._payload)


class _FailingSession:
    def __init__(self):
        self.attempts = 0

    def get(self, url, params=None, timeout=None):
        self.attempts += 1
        raise ConnectionError("network down")


def test_parse_window_averages():
    session = _FakeSession(_payload())
    window = OpenMeteoFetcher(session=session).fetch(TARGET, 25.09, 121.54)
    assert window.ok
    assert window.cloud_low == 20.0
    assert window.cloud_mid == 40.0
    assert window.cloud_high == 55.0
    assert window.visibility_m == 20000.0
    assert window.precip_prob_evening == 10.0
    assert not window.rain_recent_flag
    # 必須帶 timeout
    assert session.calls[0][2] is not None


def test_rain_recent_flag_detected():
    """12–17 時有雨、17 時後停 → 雨後放晴 flag。"""
    precip = [0.0] * 24
    precip[13] = 2.5  # 13:00 有雨
    session = _FakeSession(_payload(precip=precip))
    window = OpenMeteoFetcher(session=session).fetch(TARGET, 25.09, 121.54)
    assert window.rain_recent_flag


def test_rain_not_stopped_no_flag():
    """雨下到 17 時之後 → 不算雨後放晴。"""
    precip = [0.0] * 24
    precip[14] = 2.0
    precip[17] = 1.0
    session = _FakeSession(_payload(precip=precip))
    window = OpenMeteoFetcher(session=session).fetch(TARGET, 25.09, 121.54)
    assert not window.rain_recent_flag


def test_evening_precip_prob_is_max():
    prob = [10.0] * 24
    prob[18], prob[19] = 30.0, 75.0
    session = _FakeSession(_payload(precip_prob=prob))
    window = OpenMeteoFetcher(session=session).fetch(TARGET, 25.09, 121.54)
    assert window.precip_prob_evening == 75.0


def test_api_failure_degrades_not_raises():
    """API 失敗 → 重試一次後回傳「資料不足」結果物件，不拋例外到頂層。"""
    session = _FailingSession()
    window = OpenMeteoFetcher(session=session).fetch(TARGET, 25.09, 121.54)
    assert not window.ok
    assert window.cloud_low is None
    assert window.error and "失敗" in window.error
    assert session.attempts == 2  # 原始 + 重試一次


def test_malformed_payload_degrades():
    session = _FakeSession({"hourly": {"time": []}})
    window = OpenMeteoFetcher(session=session).fetch(TARGET, 25.09, 121.54)
    assert not window.ok
    assert window.error


def test_missing_hour_value_degrades():
    payload = _payload()
    payload["hourly"]["cloud_cover_high"][18] = None
    window = OpenMeteoFetcher(session=_FakeSession(payload)).fetch(TARGET, 25.09, 121.54)
    assert not window.ok


def test_cwa_skips_without_key():
    cc = CWAFetcher(api_key=None).fetch_crosscheck(TARGET)
    assert not cc.ok
    assert "金鑰" in (cc.error or "")
