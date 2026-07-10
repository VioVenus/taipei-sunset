"""geometry.py 測試：bearing／距離、對位判定、遮蔽提前沒入。"""

from pathlib import Path

import pytest

from sunset.geometry import (
    Viewpoint,
    assess_alignment,
    assess_obstruction,
    bearing_deg,
    distance_km,
    load_viewpoints,
    obstruction_early_minutes,
)

JIANTAN = (25.0904311, 121.5367826)
# 觀音山主峰建檔座標（由劍潭山筆記「方位 255°/11.1km」反推驗證）
GUANYINSHAN = (25.0646, 121.4303)


def test_bearing_jiantan_to_guanyinshan():
    """劍潭山 → 觀音山 bearing ≈ 255° ±1°。"""
    assert abs(bearing_deg(*JIANTAN, *GUANYINSHAN) - 255.0) <= 1.0


def test_distance_jiantan_to_guanyinshan():
    """劍潭山 → 觀音山距離 ≈ 11.1km ±0.3。"""
    assert abs(distance_km(*JIANTAN, *GUANYINSHAN) - 11.1) <= 0.3


def test_obstruction_early_minutes():
    """遮蔽 2.0° → 提前 ≈ 9.5 分鐘沒入（2.0 / 0.21）。"""
    assert obstruction_early_minutes(2.0) == pytest.approx(9.52, abs=0.1)


def _viewpoint(open_range=(250.0, 320.0), obstructions=()):
    return Viewpoint(
        id="test",
        name="測試點",
        lat=25.0,
        lon=121.5,
        elevation_m=0,
        open_azimuth_range=open_range,
        horizon_obstruction=obstructions,
    )


def test_alignment_good_inside_range():
    result = assess_alignment(_viewpoint(), sunset_azimuth=295.8)
    assert result.level == "良好"
    assert result.azimuth_diff_deg == 0.0


def test_alignment_good_within_25deg():
    result = assess_alignment(_viewpoint(open_range=(250.0, 280.0)), sunset_azimuth=296.0)
    assert result.level == "良好"
    assert result.azimuth_diff_deg <= 25.0


def test_alignment_warning_beyond_45deg():
    """差 ≥45° → 明確警告「日落在遮蔽物後方／背後」。"""
    result = assess_alignment(_viewpoint(open_range=(80.0, 120.0)), sunset_azimuth=296.0)
    assert result.level == "警告"
    assert result.azimuth_diff_deg >= 45.0
    assert "後方" in result.message


def test_alignment_range_wrapping_zero():
    """跨 0° 的開闊區間也要能判定。"""
    result = assess_alignment(_viewpoint(open_range=(330.0, 30.0)), sunset_azimuth=10.0)
    assert result.level == "良好"


def test_assess_obstruction_seed_data(tmp_path: Path):
    """大稻埕日落方位 296° 落在觀音山稜線遮蔽（290–305, 2.0°）→ 提前 ≈9.5 分。"""
    viewpoints = load_viewpoints()
    result = assess_obstruction(viewpoints["dadaocheng_wharf"], sunset_azimuth=295.9)
    assert result.matched
    assert result.angle_deg == 2.0
    assert result.early_minutes == pytest.approx(9.52, abs=0.1)


def test_assess_obstruction_no_match():
    viewpoints = load_viewpoints()
    result = assess_obstruction(viewpoints["dadaocheng_wharf"], sunset_azimuth=270.0)
    assert not result.matched
    assert result.early_minutes == 0.0


def test_load_viewpoints_seed():
    viewpoints = load_viewpoints()
    # 兩個人工實測驗證點必存在
    assert {"jiantan_laodifang", "dadaocheng_wharf"} <= set(viewpoints)
    jt = viewpoints["jiantan_laodifang"]
    assert jt.lat == pytest.approx(25.0904311)
    assert jt.open_azimuth_range == (250.0, 320.0)
    assert jt.horizon_obstruction[0].angle_deg == 0.4
    # 已驗證點不應標記待驗證
    assert not jt.needs_field_verification
    assert jt.city == "臺北市" and jt.region == "北"


def test_all_viewpoints_have_city_region_and_cover_taiwan():
    """全台點位都必須有 city/region；地區涵蓋北中南東離島；
    非人工實測遮蔽的點（有 coord_source）不得偽造遮蔽幾何（horizon_obstruction 留空）。"""
    viewpoints = load_viewpoints()
    regions = {vp.region for vp in viewpoints.values()}
    assert {"北", "中", "南", "東", "離島"} <= regions  # 全台涵蓋
    for vp in viewpoints.values():
        assert vp.city and vp.region, f"{vp.id} 缺 city/region"
        # 座標來自公開地圖研究（coord_source 記錄）的點不偽造遮蔽仰角
        if vp.coord_source:
            assert vp.horizon_obstruction == (), f"{vp.id} 不得偽造遮蔽幾何"
