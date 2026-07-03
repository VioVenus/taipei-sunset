"""天氣資料擷取：Open-Meteo（主力）、CWA（可選 stub）。

原則（歷史教訓 2、5）：
- 分層雲量是核心輸入：低雲擋太陽，只有中高雲會被日落點燃；總雲量僅供參考。
- 禁止爬網頁 HTML，一律走結構化 API。
- 所有 fetch 加 timeout、重試一次，失敗時降級輸出「資料不足」而非崩潰。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Protocol

import requests

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
REQUEST_TIMEOUT_SEC = 10.0
RETRY_COUNT = 1  # 失敗重試一次

# 評估窗口：當日 17:00–19:00（台北時間，含端點整點）
WINDOW_HOURS = (17, 18, 19)
# 死亡條款用的傍晚降雨機率：18:00–19:00 取最大
EVENING_HOURS = (18, 19)
# 雨後放晴判定：12:00–16:00 有降雨、17:00–18:00 已停
RAIN_RECENT_HOURS = (12, 13, 14, 15, 16)
RAIN_STOP_HOURS = (17, 18)
RAIN_MM_THRESHOLD = 0.1

HOURLY_FIELDS = (
    "cloud_cover_low",
    "cloud_cover_mid",
    "cloud_cover_high",
    "cloud_cover",
    "visibility",
    "precipitation_probability",
    "precipitation",
)


@dataclass(frozen=True)
class WeatherWindow:
    """17:00–19:00 評估窗口的彙總天氣（共同介面）。

    ok=False 時表示資料不足（API 失敗或欄位缺漏），數值欄位為 None。
    """

    target_date: date
    source: str
    ok: bool
    cloud_low: float | None = None
    cloud_mid: float | None = None
    cloud_high: float | None = None
    cloud_total: float | None = None
    visibility_m: float | None = None
    precip_prob_window: float | None = None  # 17–19 平均
    precip_prob_evening: float | None = None  # 18–19 最大（死亡條款）
    precip_window_mm: float | None = None
    rain_recent_flag: bool = False  # 12–17 有雨且 17 後停（雨後放晴）
    fetched_at_utc: datetime | None = None
    error: str | None = None


class WeatherFetcher(Protocol):
    """天氣來源共同介面。"""

    source_name: str

    def fetch(self, target_date: date, lat: float, lon: float) -> WeatherWindow: ...


def _mean(values: list[float]) -> float:
    return sum(values) / len(values)


def _insufficient(target_date: date, source: str, error: str) -> WeatherWindow:
    return WeatherWindow(
        target_date=target_date,
        source=source,
        ok=False,
        error=error,
        fetched_at_utc=datetime.now(UTC),
    )


class OpenMeteoFetcher:
    """Open-Meteo 逐時預報（免費、無金鑰）。"""

    source_name = "open-meteo"

    def __init__(self, session: Any | None = None) -> None:
        self._session = session if session is not None else requests

    def fetch(self, target_date: date, lat: float, lon: float) -> WeatherWindow:
        params = {
            "latitude": lat,
            "longitude": lon,
            "hourly": ",".join(HOURLY_FIELDS),
            "timezone": "Asia/Taipei",
            "start_date": target_date.isoformat(),
            "end_date": target_date.isoformat(),
        }
        payload: dict[str, Any] | None = None
        last_error = "unknown"
        for _attempt in range(RETRY_COUNT + 1):
            try:
                resp = self._session.get(OPEN_METEO_URL, params=params, timeout=REQUEST_TIMEOUT_SEC)
                resp.raise_for_status()
                payload = resp.json()
                break
            except Exception as exc:  # noqa: BLE001 - 降級路徑，不讓例外冒到頂層
                last_error = f"{type(exc).__name__}: {exc}"
        if payload is None:
            return _insufficient(target_date, self.source_name, f"Open-Meteo API 失敗：{last_error}")
        try:
            return self._parse(target_date, payload)
        except Exception as exc:  # noqa: BLE001
            return _insufficient(
                target_date, self.source_name, f"Open-Meteo 回應解析失敗：{type(exc).__name__}: {exc}"
            )

    def _parse(self, target_date: date, payload: dict[str, Any]) -> WeatherWindow:
        hourly = payload["hourly"]
        times: list[str] = hourly["time"]
        hour_index = {datetime.fromisoformat(t).hour: i for i, t in enumerate(times)}

        def series(name: str, hours: tuple[int, ...]) -> list[float]:
            col = hourly[name]
            values = []
            for h in hours:
                v = col[hour_index[h]]
                if v is None:
                    raise ValueError(f"{name}@{h}:00 缺值")
                values.append(float(v))
            return values

        precip_recent = series("precipitation", RAIN_RECENT_HOURS)
        precip_stop = series("precipitation", RAIN_STOP_HOURS)
        rain_recent = any(v > RAIN_MM_THRESHOLD for v in precip_recent) and all(
            v <= RAIN_MM_THRESHOLD for v in precip_stop
        )

        return WeatherWindow(
            target_date=target_date,
            source=self.source_name,
            ok=True,
            cloud_low=_mean(series("cloud_cover_low", WINDOW_HOURS)),
            cloud_mid=_mean(series("cloud_cover_mid", WINDOW_HOURS)),
            cloud_high=_mean(series("cloud_cover_high", WINDOW_HOURS)),
            cloud_total=_mean(series("cloud_cover", WINDOW_HOURS)),
            visibility_m=_mean(series("visibility", WINDOW_HOURS)),
            precip_prob_window=_mean(series("precipitation_probability", WINDOW_HOURS)),
            precip_prob_evening=max(series("precipitation_probability", EVENING_HOURS)),
            precip_window_mm=sum(series("precipitation", WINDOW_HOURS)),
            rain_recent_flag=rain_recent,
            fetched_at_utc=datetime.now(UTC),
        )


class CWAFetcher:
    """CWA 開放資料交叉驗證來源（Phase 0 stub）。

    未設定金鑰時回傳「資料不足」並允許跳過；Phase 1 再接實際 API
    （opendata.cwa.gov.tw，結構化 JSON，不爬網頁）。
    """

    source_name = "cwa"

    def __init__(self, api_key: str | None = None) -> None:
        self._api_key = api_key

    def fetch(self, target_date: date, lat: float, lon: float) -> WeatherWindow:
        if not self._api_key:
            return _insufficient(target_date, self.source_name, "未設定 CWA 金鑰，跳過交叉驗證")
        return _insufficient(target_date, self.source_name, "CWA fetcher 尚未實作（Phase 0 stub）")
