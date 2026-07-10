"""視線幾何：bearing／距離、觀景點資料、對位判定、遮蔽 → 提前沒入。

歷史教訓 1：幾何座標一律來自建檔資料（data/viewpoints.json），
禁止臨場猜測；新點位必須人工確認座標與視線方位後才入庫。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from sunset.paths import data_dir
from sunset.solar import SUN_DESCENT_DEG_PER_MIN

EARTH_RADIUS_KM = 6371.0088

# 幾何判定規則：與日落方位角差 ≤25° → 對位良好；≥45° → 明確警告
ALIGNMENT_GOOD_MAX_DIFF_DEG = 25.0
ALIGNMENT_WARN_MIN_DIFF_DEG = 45.0

DEFAULT_VIEWPOINTS_PATH = data_dir() / "viewpoints.json"


@dataclass(frozen=True)
class HorizonObstruction:
    """地平線遮蔽：方位區間內的遮蔽仰角。"""

    azimuth_range: tuple[float, float]
    angle_deg: float
    note: str = ""


@dataclass(frozen=True)
class Viewpoint:
    """建檔觀景點（座標與視線資料經人工實測驗證）。

    全台化後新增 city（CWA 縣市名，用臺不用台）與 region（北/中/南/東/離島）——
    分別驅動 CWA 交叉驗證的 locationName 與 UI 地區分流。

    needs_field_verification=True 的點為「草稿座標」：座標來自公開地圖/官方觀光資訊，
    尚未實地確認視線方位與遮蔽（遮蔽一律留空、open_azimuth 取寬鬆西向）。
    尊重歷史教訓 1（禁止臨場猜測遮蔽幾何）：草稿點只提供地點，不偽造遮蔽仰角，
    UI 明確標示「座標待實地確認」。coord_source 記錄出處。
    """

    id: str
    name: str
    lat: float
    lon: float
    elevation_m: float
    open_azimuth_range: tuple[float, float]
    horizon_obstruction: tuple[HorizonObstruction, ...] = ()
    type: str = ""
    access: str = ""
    weather_exclusion: str | None = None
    notes: str = ""
    city: str = ""  # CWA 縣市名（臺北市/新北市/臺中市…），驅動交叉驗證與 UI 分組
    region: str = ""  # 北 | 中 | 南 | 東 | 離島
    needs_field_verification: bool = False  # 草稿座標，遮蔽待實地確認
    coord_source: str = ""  # 座標出處（草稿點必填）


@dataclass(frozen=True)
class AlignmentResult:
    """視線對位判定結果。"""

    level: str  # "良好" | "普通" | "警告"
    azimuth_diff_deg: float
    message: str


@dataclass(frozen=True)
class ObstructionResult:
    """日落方位上的遮蔽評估。"""

    angle_deg: float
    early_minutes: float
    note: str = ""
    matched: bool = False


def load_viewpoints(path: Path | None = None) -> dict[str, Viewpoint]:
    """從 viewpoints.json 載入建檔點位，回傳 id → Viewpoint。"""
    raw = json.loads((path or DEFAULT_VIEWPOINTS_PATH).read_text(encoding="utf-8"))
    result: dict[str, Viewpoint] = {}
    for item in raw:
        obstructions = tuple(
            HorizonObstruction(
                azimuth_range=(float(o["azimuth_range"][0]), float(o["azimuth_range"][1])),
                angle_deg=float(o["angle_deg"]),
                note=o.get("note", ""),
            )
            for o in item.get("horizon_obstruction", [])
        )
        vp = Viewpoint(
            id=item["id"],
            name=item["name"],
            lat=float(item["lat"]),
            lon=float(item["lon"]),
            elevation_m=float(item.get("elevation_m", 0)),
            open_azimuth_range=(
                float(item["open_azimuth_range"][0]),
                float(item["open_azimuth_range"][1]),
            ),
            horizon_obstruction=obstructions,
            type=item.get("type", ""),
            access=item.get("access", ""),
            weather_exclusion=item.get("weather_exclusion"),
            notes=item.get("notes", ""),
            city=item.get("city", ""),
            region=item.get("region", ""),
            needs_field_verification=bool(item.get("needs_field_verification", False)),
            coord_source=item.get("coord_source", ""),
        )
        result[vp.id] = vp
    return result


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine 大圓距離（公里）。"""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """初始大圓方位角（度，北=0 順時針）。"""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlmb = math.radians(lon2 - lon1)
    x = math.sin(dlmb) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlmb)
    return math.degrees(math.atan2(x, y)) % 360.0


def _angular_diff(a: float, b: float) -> float:
    """兩方位角的最小夾角（0–180）。"""
    d = abs(a - b) % 360.0
    return 360.0 - d if d > 180.0 else d


def _in_azimuth_range(azimuth: float, rng: tuple[float, float]) -> bool:
    lo, hi = rng
    az = azimuth % 360.0
    if lo <= hi:
        return lo <= az <= hi
    return az >= lo or az <= hi  # 跨 0° 的區間

def assess_alignment(viewpoint: Viewpoint, sunset_azimuth: float) -> AlignmentResult:
    """判定日落方位角與開闊視線方位的對位品質。

    在開闊區間內 → 差 0°；否則取到區間邊界的最小夾角。
    差 ≤25° → 良好；≥45° → 警告「日落在遮蔽物後方／背後」。
    """
    if _in_azimuth_range(sunset_azimuth, viewpoint.open_azimuth_range):
        diff = 0.0
    else:
        diff = min(
            _angular_diff(sunset_azimuth, viewpoint.open_azimuth_range[0]),
            _angular_diff(sunset_azimuth, viewpoint.open_azimuth_range[1]),
        )
    if diff <= ALIGNMENT_GOOD_MAX_DIFF_DEG:
        level, message = "良好", f"日落方位 {sunset_azimuth:.1f}° 對位良好（開闊視線內或差 ≤25°）"
    elif diff >= ALIGNMENT_WARN_MIN_DIFF_DEG:
        level = "警告"
        message = f"⚠️ 日落方位 {sunset_azimuth:.1f}° 在遮蔽物後方／背後（差 {diff:.0f}°），此點位不適合"
    else:
        level, message = "普通", f"日落方位 {sunset_azimuth:.1f}° 偏離開闊視線 {diff:.0f}°，部分視野受限"
    return AlignmentResult(level=level, azimuth_diff_deg=diff, message=message)


def obstruction_early_minutes(angle_deg: float) -> float:
    """遮蔽仰角 θ° → 太陽提前沒入的分鐘數（θ / 0.21）。"""
    return angle_deg / SUN_DESCENT_DEG_PER_MIN


def assess_obstruction(viewpoint: Viewpoint, sunset_azimuth: float) -> ObstructionResult:
    """查詢日落方位上的建檔遮蔽，換算提前沒入分鐘數。"""
    best: HorizonObstruction | None = None
    for obs in viewpoint.horizon_obstruction:
        if _in_azimuth_range(sunset_azimuth, obs.azimuth_range):
            if best is None or obs.angle_deg > best.angle_deg:
                best = obs
    if best is None:
        return ObstructionResult(angle_deg=0.0, early_minutes=0.0, matched=False)
    return ObstructionResult(
        angle_deg=best.angle_deg,
        early_minutes=obstruction_early_minutes(best.angle_deg),
        note=best.note,
        matched=True,
    )
