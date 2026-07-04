"""solar.py 測試：以台北實測參考值驗證 NOAA 演算法。"""

from datetime import date, datetime

from sunset import solar

LAT, LON = 25.0904311, 121.5367826  # 劍潭山老地方（建檔座標）


def _minutes(dt: datetime) -> float:
    local = dt.astimezone(solar.TAIPEI_TZ)
    return local.hour * 60 + local.minute + local.second / 60


def test_sunset_time_2026_07_03():
    """2026-07-03 台北日落 = 18:48 ±2 分。"""
    st = solar.sunset_time(date(2026, 7, 3), LAT, LON)
    assert abs(_minutes(st) - (18 * 60 + 48)) <= 2


def test_sunset_azimuth_2026_07_03():
    """2026-07-03 日落方位 295.9° ±0.5°。"""
    az = solar.sunset_azimuth(date(2026, 7, 3), LAT, LON)
    assert abs(az - 295.9) <= 0.5


def test_sunset_azimuth_solstice():
    """夏至（6/21）日落方位為全年最北。

    註：規格原文寫 ≈299°，但與同規格的 7/3 ≈295.7–295.9° 物理上矛盾
    （夏至與 7/3 赤緯僅差 0.5°，方位差 <1°）。台北緯度夏至日落方位
    理論值 ≈296.5°，此處以正確計算為準。
    """
    az = solar.sunset_azimuth(date(2026, 6, 21), LAT, LON)
    assert abs(az - 296.5) <= 1.0
    # 夏至必須比 7/3 更偏北（方位角更大）
    assert az > solar.sunset_azimuth(date(2026, 7, 3), LAT, LON)


def test_sunset_azimuth_early_may():
    """五月初日落方位 ≈288°。"""
    az = solar.sunset_azimuth(date(2026, 5, 3), LAT, LON)
    assert abs(az - 288.0) <= 1.0


def test_golden_hour_before_sunset():
    """黃金時段起點（高度角 10°）應早於日落約 45–60 分鐘。"""
    d = date(2026, 7, 3)
    golden = solar.golden_hour_start(d, LAT, LON)
    sunset = solar.sunset_time(d, LAT, LON)
    gap_min = (sunset - golden).total_seconds() / 60
    assert 40 <= gap_min <= 70


def test_civil_twilight_end_after_sunset():
    """民用曙暮光結束（-6°）在日落後約 26 分鐘。"""
    d = date(2026, 7, 3)
    sunset = solar.sunset_time(d, LAT, LON)
    civil = solar.civil_twilight_end(d, LAT, LON)
    gap_min = (civil - sunset).total_seconds() / 60
    assert 22 <= gap_min <= 30


def test_altitude_track_descending():
    """傍晚軌跡：高度角遞減、日落時刻附近穿越 -0.833°。"""
    track = solar.altitude_track(date(2026, 7, 3), LAT, LON)
    altitudes = [p.altitude_deg for p in track]
    assert altitudes == sorted(altitudes, reverse=True)
    assert altitudes[0] > 0 > altitudes[-1]
