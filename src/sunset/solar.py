"""NOAA 太陽幾何（純 stdlib 實作，不使用 astral/pyephem）。

演算法來源：NOAA Solar Calculator（General Solar Position Calculations）。
- 日落定義：太陽幾何高度角穿越 SUNSET_ALTITUDE_DEG = -0.833°（大氣折射 + 日盤半徑）。
- 全程以 Asia/Taipei 呈現、內部計算轉 UTC。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

TAIPEI_TZ = ZoneInfo("Asia/Taipei")

# 日落：折射 (~0.567°) + 日盤半徑 (~0.266°)
SUNSET_ALTITUDE_DEG = -0.833
# 民用曙暮光結束：太陽中心 -6°
CIVIL_TWILIGHT_ALTITUDE_DEG = -6.0
# 深度黃金時段起點：高度角 10°（黃金時段 = 0–10°）
GOLDEN_HOUR_ALTITUDE_DEG = 10.0
# 近地平線太陽下沉速率（度/分鐘），遮蔽仰角 θ° → 提前 θ/0.21 分鐘沒入
SUN_DESCENT_DEG_PER_MIN = 0.21


@dataclass(frozen=True)
class SunPosition:
    """某一時刻的太陽位置（幾何高度角，未含折射修正）。"""

    at_utc: datetime
    altitude_deg: float
    azimuth_deg: float


def _julian_day(dt_utc: datetime) -> float:
    return dt_utc.timestamp() / 86400.0 + 2440587.5


def sun_position(dt: datetime, lat: float, lon: float) -> SunPosition:
    """計算指定時刻（aware datetime）的太陽高度角與方位角（NOAA 演算法）。"""
    if dt.tzinfo is None:
        raise ValueError("datetime 必須帶時區資訊")
    dt_utc = dt.astimezone(UTC)
    jd = _julian_day(dt_utc)
    jc = (jd - 2451545.0) / 36525.0

    geom_mean_long = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360.0
    geom_mean_anom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    eccent = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)

    anom_rad = math.radians(geom_mean_anom)
    eq_of_ctr = (
        math.sin(anom_rad) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
        + math.sin(2 * anom_rad) * (0.019993 - 0.000101 * jc)
        + math.sin(3 * anom_rad) * 0.000289
    )
    true_long = geom_mean_long + eq_of_ctr
    omega = math.radians(125.04 - 1934.136 * jc)
    app_long = true_long - 0.00569 - 0.00478 * math.sin(omega)

    mean_obliq = 23.0 + (26.0 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0
    obliq_corr = mean_obliq + 0.00256 * math.cos(omega)
    obliq_rad = math.radians(obliq_corr)
    app_long_rad = math.radians(app_long)

    declination = math.asin(math.sin(obliq_rad) * math.sin(app_long_rad))

    var_y = math.tan(obliq_rad / 2.0) ** 2
    geom_long_rad = math.radians(geom_mean_long)
    eq_of_time_min = 4.0 * math.degrees(
        var_y * math.sin(2 * geom_long_rad)
        - 2 * eccent * math.sin(anom_rad)
        + 4 * eccent * var_y * math.sin(anom_rad) * math.cos(2 * geom_long_rad)
        - 0.5 * var_y * var_y * math.sin(4 * geom_long_rad)
        - 1.25 * eccent * eccent * math.sin(2 * anom_rad)
    )

    minutes_utc = dt_utc.hour * 60.0 + dt_utc.minute + dt_utc.second / 60.0
    true_solar_min = (minutes_utc + eq_of_time_min + 4.0 * lon) % 1440.0
    hour_angle = true_solar_min / 4.0 - 180.0
    ha_rad = math.radians(hour_angle)
    lat_rad = math.radians(lat)

    cos_zenith = math.sin(lat_rad) * math.sin(declination) + math.cos(lat_rad) * math.cos(
        declination
    ) * math.cos(ha_rad)
    cos_zenith = max(-1.0, min(1.0, cos_zenith))
    zenith = math.acos(cos_zenith)
    altitude = 90.0 - math.degrees(zenith)

    sin_zenith = math.sin(zenith)
    if abs(sin_zenith) < 1e-9:
        azimuth = 180.0
    else:
        cos_az = (math.sin(lat_rad) * math.cos(zenith) - math.sin(declination)) / (
            math.cos(lat_rad) * sin_zenith
        )
        cos_az = max(-1.0, min(1.0, cos_az))
        az = math.degrees(math.acos(cos_az))
        azimuth = (az + 180.0) % 360.0 if hour_angle > 0 else (540.0 - az) % 360.0

    return SunPosition(at_utc=dt_utc, altitude_deg=altitude, azimuth_deg=azimuth)


def _find_altitude_crossing(
    target_date: date,
    lat: float,
    lon: float,
    altitude_deg: float,
    window_start: time,
    window_end: time,
) -> datetime | None:
    """在台北時間 window 內二分搜尋高度角下降穿越 altitude_deg 的時刻。"""
    lo = datetime.combine(target_date, window_start, tzinfo=TAIPEI_TZ)
    hi = datetime.combine(target_date, window_end, tzinfo=TAIPEI_TZ)
    f_lo = sun_position(lo, lat, lon).altitude_deg - altitude_deg
    f_hi = sun_position(hi, lat, lon).altitude_deg - altitude_deg
    if f_lo < 0 or f_hi > 0:  # 窗口內無下降穿越
        return None
    for _ in range(40):
        mid = lo + (hi - lo) / 2
        if sun_position(mid, lat, lon).altitude_deg - altitude_deg > 0:
            lo = mid
        else:
            hi = mid
    return (lo + (hi - lo) / 2).astimezone(TAIPEI_TZ)


def sunset_time(target_date: date, lat: float, lon: float) -> datetime:
    """日落時刻（Asia/Taipei）：高度角下降穿越 -0.833°。"""
    result = _find_altitude_crossing(
        target_date, lat, lon, SUNSET_ALTITUDE_DEG, time(15, 0), time(21, 0)
    )
    if result is None:
        raise ValueError(f"{target_date} 於 ({lat}, {lon}) 找不到日落時刻")
    return result


def sunset_azimuth(target_date: date, lat: float, lon: float) -> float:
    """日落時刻的太陽方位角（度，北=0 順時針）。"""
    at = sunset_time(target_date, lat, lon)
    return sun_position(at, lat, lon).azimuth_deg


def golden_hour_start(target_date: date, lat: float, lon: float) -> datetime:
    """深度黃金時段起點：高度角下降穿越 10°。"""
    result = _find_altitude_crossing(
        target_date, lat, lon, GOLDEN_HOUR_ALTITUDE_DEG, time(12, 0), time(21, 0)
    )
    if result is None:
        raise ValueError(f"{target_date} 於 ({lat}, {lon}) 找不到黃金時段起點")
    return result


def civil_twilight_end(target_date: date, lat: float, lon: float) -> datetime:
    """民用曙暮光結束：高度角下降穿越 -6°（日落後約 26 分鐘）。"""
    result = _find_altitude_crossing(
        target_date, lat, lon, CIVIL_TWILIGHT_ALTITUDE_DEG, time(15, 0), time(22, 0)
    )
    if result is None:
        raise ValueError(f"{target_date} 於 ({lat}, {lon}) 找不到民用曙暮光結束時刻")
    return result


def altitude_track(
    target_date: date,
    lat: float,
    lon: float,
    start: time = time(16, 0),
    end: time = time(19, 30),
    step_minutes: int = 10,
) -> list[SunPosition]:
    """回傳台北時間 start–end 間隔 step_minutes 的太陽位置序列。"""
    cursor = datetime.combine(target_date, start, tzinfo=TAIPEI_TZ)
    stop = datetime.combine(target_date, end, tzinfo=TAIPEI_TZ)
    track: list[SunPosition] = []
    while cursor <= stop:
        track.append(sun_position(cursor, lat, lon))
        cursor += timedelta(minutes=step_minutes)
    return track
