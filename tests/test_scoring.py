"""scoring.py 測試：規則引擎 v1 的關鍵行為。"""

import pytest

from sunset.scoring import ScoringInput, prob_interval, score


def _total(p):
    return p.a + p.b + p.c + p.d


def test_ideal_band_cd_at_least_50():
    """理想帶（low<30、30≤mid_high≤70）→ C+D ≥ 50。"""
    p = score(ScoringInput(cloud_low=15, cloud_mid=20, cloud_high=50))
    assert p.burn_level >= 50
    assert _total(p) == pytest.approx(100.0)


def test_death_clause_low_cloud():
    """死亡條款（low > 70）→ A ≥ 60。"""
    p = score(ScoringInput(cloud_low=85, cloud_mid=40, cloud_high=10))
    assert p.a >= 60
    assert _total(p) == pytest.approx(100.0)


def test_death_clause_precip():
    """死亡條款（18–19 時降雨機率 > 60）→ A ≥ 60。"""
    p = score(ScoringInput(cloud_low=20, cloud_mid=50, cloud_high=50, precip_prob_evening=80))
    assert p.a >= 60
    assert _total(p) == pytest.approx(100.0)


def test_sum_always_100():
    """四情境總和恆為 100（掃過參數空間）。"""
    for low in (0, 20, 45, 65, 80, 100):
        for mid in (0, 40, 90):
            for high in (0, 25, 60, 95):
                for precip in (0, 50, 90):
                    p = score(
                        ScoringInput(
                            cloud_low=low,
                            cloud_mid=mid,
                            cloud_high=high,
                            precip_prob_evening=precip,
                            burned_yesterday=True,
                            rain_clearing=True,
                            front_within_48h=True,
                        )
                    )
                    assert _total(p) == pytest.approx(100.0)
                    assert min(p.a, p.b, p.c, p.d) >= 0


def test_anti_pessimism_clause():
    """防過度悲觀條款：cloud_high ≥ 20 時 C+D ≥ 15（歷史教訓 5/25）。

    嚴重死亡條款情境（low=90 → A=90、B/C/D=5/3/2，C+D 原為 5）下，
    高雲 30% 仍應把 C+D 拉回 15。
    """
    p = score(ScoringInput(cloud_low=90, cloud_mid=10, cloud_high=30))
    assert p.burn_level >= 15.0 - 1e-9
    assert p.a >= 60  # 死亡條款 A 地板仍須維持
    assert _total(p) == pytest.approx(100.0)


def test_anti_pessimism_not_applied_when_high_below_20():
    """高雲 < 20 時不啟動防悲觀條款。"""
    p = score(ScoringInput(cloud_low=90, cloud_mid=10, cloud_high=10))
    assert p.burn_level < 15.0


def test_bonus_cap_25():
    """三項加成合計 45 → 夾至 +25：C+D 恰比無加成情況高 25。"""
    base = score(ScoringInput(cloud_low=10, cloud_mid=50, cloud_high=50))
    boosted = score(
        ScoringInput(
            cloud_low=10,
            cloud_mid=50,
            cloud_high=50,
            burned_yesterday=True,
            rain_clearing=True,
            front_within_48h=True,
        )
    )
    assert boosted.burn_level - base.burn_level == pytest.approx(25.0)
    assert _total(boosted) == pytest.approx(100.0)


def test_single_bonus_rain_clearing():
    """單一加成（雨後放晴 +20）完整生效。"""
    base = score(ScoringInput(cloud_low=10, cloud_mid=50, cloud_high=50))
    boosted = score(ScoringInput(cloud_low=10, cloud_mid=50, cloud_high=50, rain_clearing=True))
    assert boosted.burn_level - base.burn_level == pytest.approx(20.0)


def test_low_interference_shifts_to_a():
    """低雲干擾（30≤low≤60）：向 A 移轉 20 個百分點。"""
    clear = score(ScoringInput(cloud_low=10, cloud_mid=50, cloud_high=50))
    hazy = score(ScoringInput(cloud_low=45, cloud_mid=50, cloud_high=50))
    assert hazy.a - clear.a == pytest.approx(20.0)
    assert _total(hazy) == pytest.approx(100.0)


def test_too_clean_favours_b():
    """mid_high < 30（天太乾淨）→ B 為主。"""
    p = score(ScoringInput(cloud_low=10, cloud_mid=10, cloud_high=15))
    assert p.b == pytest.approx(60.0)
    assert p.burn_level == pytest.approx(30.0)


def test_reasons_present():
    p = score(ScoringInput(cloud_low=15, cloud_mid=20, cloud_high=50, rain_clearing=True))
    assert any("雨後放晴" in r for r in p.reasons)
    assert any("理想帶" in r for r in p.reasons)


def test_prob_interval_clamped():
    """區間輸出 ±10、夾在 [0,100]。"""
    assert prob_interval(50) == (40, 60)
    assert prob_interval(5) == (0, 15)
    assert prob_interval(97) == (87, 100)
