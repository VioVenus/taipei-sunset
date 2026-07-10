"""天氣資料擷取：Open-Meteo（主力）、CWA（可選 stub）。

原則（歷史教訓 2、5）：
- 分層雲量是核心輸入：低雲擋太陽，只有中高雲會被日落點燃；總雲量僅供參考。
- 禁止爬網頁 HTML，一律走結構化 API。
- 所有 fetch 加 timeout、重試一次，失敗時降級輸出「資料不足」而非崩潰。
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from typing import Any, Protocol

import requests

from sunset import solar

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
REQUEST_TIMEOUT_SEC = 10.0
RETRY_COUNT = 1  # 失敗重試一次

# 評估窗口以「當日該點的實際日落時刻」為中心動態決定（v1.2.0）：
# 火燒雲是繞著日落時刻發生的現象，全台跨緯度、跨季節日落時刻不同
# （台北夏季 ~18:47、恆春/冬季 ~17:10），固定 17–19 會在南部/東部/冬季失準。
# 以下四個窗口皆相對 sunset_hour；當 sunset_hour=18（台北夏季）時退回原固定值，
# 保完全後向相容：window (17,18,19)｜evening (18,19)｜recent 12–16｜stop (17,18)。
DEFAULT_SUNSET_HOUR = 18  # 日落時刻求解失敗時的保底（台灣一定有日落，僅防禦）
RAIN_MM_THRESHOLD = 0.1


def _window_hours(sunset_hour: int) -> tuple[int, int, int]:
    """評估窗口：日落前後各一小時（含日落所在整點）。"""
    return (sunset_hour - 1, sunset_hour, sunset_hour + 1)


def _evening_hours(sunset_hour: int) -> tuple[int, int]:
    """死亡條款用傍晚降雨：日落整點與其後一小時取最大。"""
    return (sunset_hour, sunset_hour + 1)


def _rain_recent_hours(sunset_hour: int) -> tuple[int, ...]:
    """雨後放晴判定的午後時段：窗口前 2–6 小時（共 5 小時）。"""
    return tuple(range(sunset_hour - 6, sunset_hour - 1))


def _rain_stop_hours(sunset_hour: int) -> tuple[int, int]:
    """雨後放晴判定的『已停』時段：日落前一小時到日落整點。"""
    return (sunset_hour - 1, sunset_hour)


def _sunset_hour(target_date: date, lat: float, lon: float) -> int:
    """當日該點日落所在的台北時整點（求解失敗保底 18）。"""
    try:
        return solar.sunset_time(target_date, lat, lon).hour
    except Exception:  # noqa: BLE001 - 防禦：台灣一定有日落
        return DEFAULT_SUNSET_HOUR

HOURLY_FIELDS = (
    "cloud_cover_low",
    "cloud_cover_mid",
    "cloud_cover_high",
    "cloud_cover",
    "visibility",
    "precipitation_probability",
    "precipitation",
)

# 多模式集成（第二次輕量呼叫，只拿雲量三層）：
# 主呼叫維持 best_match（引擎輸入的 canonical 不變），集成僅用於不確定性量化。
ENSEMBLE_MODELS = ("icon_seamless", "gfs_seamless")
ENSEMBLE_CLOUD_FIELDS = ("cloud_cover_low", "cloud_cover_mid", "cloud_cover_high")


@dataclass(frozen=True)
class WeatherWindow:
    """以日落時刻為中心的評估窗口彙總天氣（共同介面）。

    窗口為日落前後各一小時（見 weather._window_hours），跨全台、跨季節動態決定。
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
    # 多模式分歧（跨模式 mid_high 與 low 的最大差，取兩者較大者）；
    # None = 集成資料取不到 → 顯示層退回固定 ±10 區間。評分機率不受影響。
    model_spread: float | None = None
    ensemble_models: str = ""  # 例如 "best_match,icon_seamless,gfs_seamless"
    window_label: str = ""  # 評估窗口顯示標籤，例如 "17–19時"（動態，依日落時刻）


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
        sunset_hour = _sunset_hour(target_date, lat, lon)
        try:
            window = self._parse(target_date, payload, sunset_hour)
        except Exception as exc:  # noqa: BLE001
            return _insufficient(
                target_date, self.source_name, f"Open-Meteo 回應解析失敗：{type(exc).__name__}: {exc}"
            )
        # 集成分歧為加值資訊：失敗不影響主結果（引擎輸入不變、區間退回固定寬度）
        spread, models = self._ensemble_spread(target_date, lat, lon, window, sunset_hour)
        if spread is None:
            return window
        return replace(window, model_spread=spread, ensemble_models=models)

    def _ensemble_spread(
        self, target_date: date, lat: float, lon: float, base: WeatherWindow, sunset_hour: int
    ) -> tuple[float | None, str]:
        """跨模式雲量分歧：members = best_match（主呼叫）∪ ENSEMBLE_MODELS。

        spread = max(跨模式 mid_high 最大差, 跨模式 low 最大差)。任何失敗 → (None, "")。
        """
        params = {
            "latitude": lat,
            "longitude": lon,
            "hourly": ",".join(ENSEMBLE_CLOUD_FIELDS),
            "models": ",".join(ENSEMBLE_MODELS),
            "timezone": "Asia/Taipei",
            "start_date": target_date.isoformat(),
            "end_date": target_date.isoformat(),
        }
        try:
            resp = self._session.get(OPEN_METEO_URL, params=params, timeout=REQUEST_TIMEOUT_SEC)
            resp.raise_for_status()
            hourly = resp.json()["hourly"]
            times: list[str] = hourly["time"]
            hour_index = {datetime.fromisoformat(t).hour: i for i, t in enumerate(times)}

            window_hours = _window_hours(sunset_hour)

            def window_mean(field: str, model: str) -> float:
                col = hourly[f"{field}_{model}"]
                raw = [col[hour_index[h]] for h in window_hours]
                if any(v is None for v in raw):
                    raise ValueError("缺值")
                return sum(float(v) for v in raw) / len(raw)

            lows = [base.cloud_low or 0.0]
            mid_highs = [max(base.cloud_mid or 0.0, base.cloud_high or 0.0)]
            for model in ENSEMBLE_MODELS:
                lows.append(window_mean("cloud_cover_low", model))
                mid_highs.append(
                    max(
                        window_mean("cloud_cover_mid", model),
                        window_mean("cloud_cover_high", model),
                    )
                )
            spread = max(max(mid_highs) - min(mid_highs), max(lows) - min(lows))
            return spread, ",".join(("best_match", *ENSEMBLE_MODELS))
        except Exception:  # noqa: BLE001 - 加值路徑，靜默降級
            return None, ""

    def _parse(
        self, target_date: date, payload: dict[str, Any], sunset_hour: int
    ) -> WeatherWindow:
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

        window_hours = _window_hours(sunset_hour)
        evening_hours = _evening_hours(sunset_hour)
        precip_recent = series("precipitation", _rain_recent_hours(sunset_hour))
        precip_stop = series("precipitation", _rain_stop_hours(sunset_hour))
        rain_recent = any(v > RAIN_MM_THRESHOLD for v in precip_recent) and all(
            v <= RAIN_MM_THRESHOLD for v in precip_stop
        )

        return WeatherWindow(
            target_date=target_date,
            source=self.source_name,
            ok=True,
            cloud_low=_mean(series("cloud_cover_low", window_hours)),
            cloud_mid=_mean(series("cloud_cover_mid", window_hours)),
            cloud_high=_mean(series("cloud_cover_high", window_hours)),
            cloud_total=_mean(series("cloud_cover", window_hours)),
            visibility_m=_mean(series("visibility", window_hours)),
            precip_prob_window=_mean(series("precipitation_probability", window_hours)),
            precip_prob_evening=max(series("precipitation_probability", evening_hours)),
            precip_window_mm=sum(series("precipitation", window_hours)),
            rain_recent_flag=rain_recent,
            fetched_at_utc=datetime.now(UTC),
            window_label=f"{window_hours[0]:02d}–{window_hours[-1]:02d}時",
        )


CWA_FORECAST_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001"
CWA_DEFAULT_LOCATION = "臺北市"  # 點位未標 city 時的後備
# 與 Open-Meteo 傍晚降雨機率相差超過此值 → 標示來源分歧（提醒不確定性高）
CWA_DISAGREEMENT_POP = 30.0


@dataclass(frozen=True)
class CWACrossCheck:
    """CWA 交叉驗證結果（僅顯示層使用，不進評分引擎——資料紀律：

    引擎輸入維持單一 canonical 來源，跨源差異呈現給人而非悄悄混合）。
    """

    ok: bool
    wx_text: str = ""  # 天氣現象，例如「多雲時晴」
    pop_percent: float | None = None  # 該時段降雨機率
    period_label: str = ""  # 例如「今晚至明晨」
    location_name: str = ""  # 對應的縣市（全台 per-city）
    error: str | None = None


class CWAFetcher:
    """CWA 開放資料（opendata.cwa.gov.tw，F-C0032-001 一般天氣預報-36小時）。

    交叉驗證來源：取指定縣市涵蓋目標日傍晚 18:00 的預報時段。F-C0032-001
    一次涵蓋全台 22 縣市，故一把金鑰即可服務全台各點（按 locationName 取用）。
    未設金鑰或失敗 → ok=False，呼叫端跳過（不影響主流程）。
    """

    source_name = "cwa"

    def __init__(self, api_key: str | None = None, session: Any | None = None) -> None:
        self._api_key = api_key
        self._session = session if session is not None else requests

    def fetch_crosscheck(
        self, target_date: date, location_name: str = CWA_DEFAULT_LOCATION
    ) -> CWACrossCheck:
        location_name = location_name or CWA_DEFAULT_LOCATION
        if not self._api_key:
            return CWACrossCheck(
                ok=False, location_name=location_name, error="未設定 CWA 金鑰，跳過交叉驗證"
            )
        params = {"Authorization": self._api_key, "locationName": location_name}
        try:
            resp = self._session.get(CWA_FORECAST_URL, params=params, timeout=REQUEST_TIMEOUT_SEC)
            resp.raise_for_status()
            payload = resp.json()
        except Exception as exc:  # noqa: BLE001 - 降級路徑
            return CWACrossCheck(
                ok=False, location_name=location_name, error=f"CWA API 失敗：{type(exc).__name__}"
            )
        try:
            return self._parse(target_date, payload, location_name)
        except Exception as exc:  # noqa: BLE001
            return CWACrossCheck(
                ok=False,
                location_name=location_name,
                error=f"CWA 回應解析失敗：{type(exc).__name__}",
            )

    def _parse(
        self, target_date: date, payload: dict[str, Any], location_name: str
    ) -> CWACrossCheck:
        location = payload["records"]["location"][0]
        elements = {e["elementName"]: e["time"] for e in location["weatherElement"]}
        # 目標時刻：當日傍晚 18:00（評估窗口中心）
        target = datetime.fromisoformat(f"{target_date.isoformat()}T18:00:00")

        def value_at(element_name: str) -> tuple[str, str]:
            for slot in elements[element_name]:
                start = datetime.fromisoformat(slot["startTime"])
                end = datetime.fromisoformat(slot["endTime"])
                if start <= target < end:
                    label = f"{start.strftime('%m/%d %H時')}–{end.strftime('%H時')}"
                    return slot["parameter"]["parameterName"], label
            raise ValueError(f"{element_name} 無涵蓋 {target} 的時段")

        wx_text, period_label = value_at("Wx")
        pop_raw, _ = value_at("PoP")
        return CWACrossCheck(
            ok=True,
            wx_text=wx_text,
            pop_percent=float(pop_raw),
            period_label=period_label,
            location_name=location_name,
        )
