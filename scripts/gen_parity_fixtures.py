"""產生 JS/Python parity 測試 fixtures（Python 為 canonical）。

輸出 web/test/fixtures.json，由 `node --test web/test` 比對 JS 移植版。
任何評分/幾何常數變動後必須重跑本腳本並 bump ENGINE_VERSION。
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sunset import solar  # noqa: E402
from sunset.geometry import bearing_deg, distance_km  # noqa: E402
from sunset.scoring import ScoringInput, score  # noqa: E402

JIANTAN = (25.0904311, 121.5367826)
DADAOCHENG = (25.0565135, 121.5075150)
GUANYINSHAN = (25.0646, 121.4303)

OUT = Path(__file__).resolve().parents[1] / "web" / "test" / "fixtures.json"


def solar_fixtures() -> list[dict]:
    rows = []
    for d in (date(2026, 7, 3), date(2026, 7, 4), date(2026, 6, 21), date(2026, 5, 3), date(2026, 12, 21)):
        for name, (lat, lon) in (("jiantan", JIANTAN), ("dadaocheng", DADAOCHENG)):
            rows.append(
                {
                    "date": d.isoformat(),
                    "site": name,
                    "lat": lat,
                    "lon": lon,
                    "sunset_ms": int(solar.sunset_time(d, lat, lon).timestamp() * 1000),
                    "azimuth": solar.sunset_azimuth(d, lat, lon),
                    "golden_ms": int(solar.golden_hour_start(d, lat, lon).timestamp() * 1000),
                    "civil_ms": int(solar.civil_twilight_end(d, lat, lon).timestamp() * 1000),
                }
            )
    return rows


def geometry_fixtures() -> list[dict]:
    pairs = [
        ("jiantan->guanyinshan", JIANTAN, GUANYINSHAN),
        ("dadaocheng->guanyinshan", DADAOCHENG, GUANYINSHAN),
        ("jiantan->dadaocheng", JIANTAN, DADAOCHENG),
    ]
    return [
        {
            "name": name,
            "from": a,
            "to": b,
            "bearing": bearing_deg(*a, *b),
            "distance_km": distance_km(*a, *b),
        }
        for name, a, b in pairs
    ]


def scoring_fixtures() -> list[dict]:
    rows = []
    for low in (0, 10, 20, 35, 50, 65, 80, 95):
        for mid in (0, 25, 55, 90):
            for high in (0, 15, 30, 60, 95):
                for precip in (0, 40, 75):
                    for flags in ((0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 1)):
                        inp = ScoringInput(
                            cloud_low=low,
                            cloud_mid=mid,
                            cloud_high=high,
                            precip_prob_evening=precip,
                            burned_yesterday=bool(flags[0]),
                            rain_clearing=bool(flags[1]),
                            front_within_48h=bool(flags[2]),
                        )
                        p = score(inp)
                        rows.append(
                            {
                                "in": [low, mid, high, precip, *flags],
                                "out": [round(p.a, 6), round(p.b, 6), round(p.c, 6), round(p.d, 6)],
                            }
                        )
    return rows


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    fixtures = {
        "engine_version": "v1.0.0",
        "solar": solar_fixtures(),
        "geometry": geometry_fixtures(),
        "scoring": scoring_fixtures(),
    }
    OUT.write_text(json.dumps(fixtures, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT} ({len(fixtures['scoring'])} scoring cases)")


if __name__ == "__main__":
    main()
