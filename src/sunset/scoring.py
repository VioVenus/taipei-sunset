"""評分引擎 v1（規則式）：分層雲量 → 四情境機率 A/B/C/D。

- 所有規則常數集中於此，方便日後校準；任何常數變動都要 bump ENGINE_VERSION。
- 四情境（純看『天空色彩／戲劇性』一軸，與『看不看得到太陽本身』脫鉤——見教訓 6）：
    A 灰暗無色（低雲/降雨整片罩住，幾乎沒有色彩）
    B 橘色天空／霞光（有明顯橘黃，但沒有粉紅紫紅的燒；不論看不看得到太陽本身）
    C 局部火燒（部分天空被點成粉紅/紅）
    D 全面火燒（整片天空燒起來）
  「太陽本身看不看得到」是另一個獨立軸（由低雲那條帶主導），以理由與可選回報欄位呈現，
  不併進 A–D。低雲高 → 擋住日輪，但上方中高雲仍可能被點亮成 B/C/D。
- 機率以 0–100 浮點表示，總和恆為 100；輸出一律為區間（±10 個百分點），禁止假精確。
"""

from __future__ import annotations

from dataclasses import dataclass

# v1.3.0：釐清四情境『分類定義』——把「看不看得到太陽本身」從 A–D 脫鉤（教訓 6，
#   來自使用者實地回報：低雲帶擋住日輪、但滿天橘色）。B 重定義為「橘色天空/霞光」而非
#   「看得到太陽下山」；新增日輪遮蔽的理由。機率『分配函式』與常數完全不變，故 scoring
#   parity fixtures 數值不變——這是語意釐清，非數值調參。
# v1.2.0：評估窗口改為以「當日該點實際日落時刻」為中心動態決定（見 weather.py）。
# v1.1.0：新增動態不確定性區間（多模式分歧 → 區間加寬）。
ENGINE_VERSION = "v1.3.0"

# ── 基礎分配 ──────────────────────────────────────────────
LOW_CLEAR_MAX = 30.0  # low < 30 視為地平線有縫
MID_HIGH_IDEAL_MIN = 30.0
MID_HIGH_IDEAL_MAX = 70.0
BASE_IDEAL = (15.0, 25.0, 35.0, 25.0)  # 理想帶
BASE_TOO_CLEAN = (10.0, 60.0, 22.0, 8.0)  # mid_high < 30：天太乾淨
BASE_TOO_THICK = (25.0, 35.0, 28.0, 12.0)  # mid_high > 70：高雲太厚

# ── 低雲干擾 ──────────────────────────────────────────────
# 規格定義 30 ≤ low ≤ 60；60 < low ≤ 70 未定義，保守沿用同一移轉（gap-fill）
LOW_INTERFERENCE_MIN = 30.0
LOW_INTERFERENCE_MAX = 70.0
LOW_INTERFERENCE_SHIFT = 20.0  # 向 A 移轉的百分點（按比例從 B/C/D 扣）

# ── 死亡條款 ──────────────────────────────────────────────
DEATH_LOW_CLOUD = 70.0  # low > 70
DEATH_PRECIP_PROB = 60.0  # 18:00–19:00 降雨機率 > 60
DEATH_A_FLOOR = 60.0  # A 地板
DEATH_A_CAP = 90.0  # A 隨嚴重度上升的上限
DEATH_REMAINDER_RATIO = (5.0, 3.0, 2.0)  # 剩餘按 B:C:D 分配

# ── 觸發加成（作用於 C+D，從 A/B 按比例移轉）───────────────
BONUS_BURNED_YESTERDAY = 15.0  # 昨日有燒（持續性 24–48h）
BONUS_RAIN_CLEARING = 20.0  # 雨後放晴
BONUS_FRONT = 10.0  # 鋒面/颱風外圍 48h 內（Phase 0 人工 flag）
BONUS_DAILY_CAP = 25.0  # 單日加成上限

# ── 防過度悲觀條款（歷史教訓 3，5/25）─────────────────────
ANTI_PESSIMISM_HIGH_MIN = 20.0  # cloud_high ≥ 20 時生效
ANTI_PESSIMISM_CD_FLOOR = 15.0  # C+D 合計不得低於 15%

# ── 日輪可見度提示（教訓 6，不改機率，只在理由層講清楚兩軸）──────────────
# 低雲在此區間 → 太陽本身（日輪）很可能被地平線附近的低雲帶擋住；
# 但上方中高雲 ≥ DISK_SKY_FUEL_MIN 時仍可能被點亮（滿天橘色甚至火燒）。
DISK_SKY_FUEL_MIN = 20.0

# ── 輸出格式：動態不確定性區間 ────────────────────────────
# 基準 ±10；多模式雲量分歧越大，區間越寬（誠實反映預報不確定性），上限 ±25。
# half_width = clamp(10 + 0.5 × model_spread 超出門檻部分, 10, 25)
PROB_INTERVAL_HALF_WIDTH = 10.0  # 基準半寬（無集成資料時的固定值）
PROB_INTERVAL_MAX_HALF_WIDTH = 25.0
INTERVAL_SPREAD_THRESHOLD = 10.0  # 分歧 ≤10% 視為正常雜訊，不加寬
INTERVAL_SPREAD_FACTOR = 0.5


def dynamic_half_width(model_spread: float | None) -> float:
    """多模式分歧 → 區間半寬。None（無集成資料）→ 基準 ±10。"""
    if model_spread is None:
        return PROB_INTERVAL_HALF_WIDTH
    widened = PROB_INTERVAL_HALF_WIDTH + INTERVAL_SPREAD_FACTOR * max(
        0.0, model_spread - INTERVAL_SPREAD_THRESHOLD
    )
    return min(PROB_INTERVAL_MAX_HALF_WIDTH, max(PROB_INTERVAL_HALF_WIDTH, widened))


@dataclass(frozen=True)
class ScoringInput:
    """評分輸入：17:00–19:00 窗口平均雲量 + 旗標。"""

    cloud_low: float
    cloud_mid: float
    cloud_high: float
    precip_prob_evening: float = 0.0  # 18:00–19:00 最大降雨機率
    burned_yesterday: bool = False  # 來源：結果日誌昨日實際回報（非預測）
    rain_clearing: bool = False  # 當日 12–17 有雨且 17 後停
    front_within_48h: bool = False  # Phase 0 人工 flag


@dataclass(frozen=True)
class ScenarioProbs:
    """四情境機率（總和 = 100）與理由。"""

    a: float
    b: float
    c: float
    d: float
    reasons: tuple[str, ...]
    engine_version: str = ENGINE_VERSION

    @property
    def sunset_visible(self) -> float:
        """看得到夕陽景象（有橘色以上的天空）= B + C + D。

        注意：這是『天空有色彩』而非『看得到太陽本身』——日輪可能被低雲擋住，
        天空仍可能一整片橘色（教訓 6）。
        """
        return self.b + self.c + self.d

    @property
    def burn_level(self) -> float:
        """火燒雲等級 = C + D。"""
        return self.c + self.d


def prob_interval(point: float, half_width: float | None = None) -> tuple[int, int]:
    """點估 → 區間（±half_width，夾在 [0,100]）。禁止輸出單點假精確。"""
    hw = PROB_INTERVAL_HALF_WIDTH if half_width is None else half_width
    lo = max(0.0, point - hw)
    hi = min(100.0, point + hw)
    return round(lo), round(hi)


def _transfer_to_cd(
    probs: list[float], amount: float, a_floor: float = 0.0
) -> tuple[list[float], float]:
    """從 A/B 按比例移出 amount 到 C/D（依 C:D 現值比例分配）。

    A 不會被扣到 a_floor 以下；可移轉量不足時做部分移轉。
    回傳（新機率, 實際移轉量）。
    """
    a, b, c, d = probs
    avail_a = max(0.0, a - a_floor)
    avail_b = max(0.0, b)
    pool = avail_a + avail_b
    moved = min(amount, pool)
    if moved <= 0 or pool <= 0:
        return [a, b, c, d], 0.0
    take_a = moved * avail_a / pool
    take_b = moved * avail_b / pool
    cd = c + d
    add_c = moved * (c / cd) if cd > 0 else moved / 2
    add_d = moved - add_c
    return [a - take_a, b - take_b, c + add_c, d + add_d], moved


def score(inp: ScoringInput) -> ScenarioProbs:
    """規則引擎 v1：features → 四情境機率 + 理由列表。"""
    reasons: list[str] = []
    mid_high = max(inp.cloud_mid, inp.cloud_high)
    reasons.append(
        f"低雲 {inp.cloud_low:.0f}%／中雲 {inp.cloud_mid:.0f}%／高雲 {inp.cloud_high:.0f}%"
        f"（mid_high = {mid_high:.0f}%）"
    )

    death = inp.cloud_low > DEATH_LOW_CLOUD or inp.precip_prob_evening > DEATH_PRECIP_PROB
    a_floor = 0.0

    if death:
        # 死亡條款：A 有 60 地板，並隨嚴重度（低雲量/降雨機率）上升，剩餘按 5:3:2
        severity = 0.0
        if inp.cloud_low > DEATH_LOW_CLOUD:
            severity = max(severity, inp.cloud_low)
            reasons.append(f"💀 死亡條款：低雲 {inp.cloud_low:.0f}% > {DEATH_LOW_CLOUD:.0f}%")
        if inp.precip_prob_evening > DEATH_PRECIP_PROB:
            severity = max(severity, inp.precip_prob_evening)
            reasons.append(
                f"💀 死亡條款：18–19 時降雨機率 {inp.precip_prob_evening:.0f}% > "
                f"{DEATH_PRECIP_PROB:.0f}%"
            )
        a = min(max(DEATH_A_FLOOR, severity), DEATH_A_CAP)
        remainder = 100.0 - a
        ratio_sum = sum(DEATH_REMAINDER_RATIO)
        probs = [
            a,
            remainder * DEATH_REMAINDER_RATIO[0] / ratio_sum,
            remainder * DEATH_REMAINDER_RATIO[1] / ratio_sum,
            remainder * DEATH_REMAINDER_RATIO[2] / ratio_sum,
        ]
        a_floor = DEATH_A_FLOOR
    else:
        if inp.cloud_low < LOW_CLEAR_MAX and MID_HIGH_IDEAL_MIN <= mid_high <= MID_HIGH_IDEAL_MAX:
            probs = list(BASE_IDEAL)
            reasons.append("理想帶：低雲有縫且中高雲量適中（有燃料、不悶死）")
        elif mid_high < MID_HIGH_IDEAL_MIN:
            probs = list(BASE_TOO_CLEAN)
            reasons.append("中高雲偏少，天太乾淨，偏向普通橘色夕陽")
        elif mid_high > MID_HIGH_IDEAL_MAX:
            probs = list(BASE_TOO_THICK)
            reasons.append("中高雲太厚，光可能穿不透")
        else:
            probs = list(BASE_IDEAL)
            reasons.append("中高雲量適中（有燃料）")

        if LOW_INTERFERENCE_MIN <= inp.cloud_low <= LOW_INTERFERENCE_MAX:
            shift = LOW_INTERFERENCE_SHIFT
            bcd = probs[1] + probs[2] + probs[3]
            take = min(shift, bcd)
            probs = [
                probs[0] + take,
                probs[1] - take * probs[1] / bcd,
                probs[2] - take * probs[2] / bcd,
                probs[3] - take * probs[3] / bcd,
            ]
            reasons.append(f"低雲干擾（{inp.cloud_low:.0f}%）：向 A 移轉 {take:.0f} 個百分點")
            # 兩軸提示：低雲擋日輪，但上方有燃料時天空仍可能有色彩（使用者實地回報的情境）
            if mid_high >= DISK_SKY_FUEL_MIN:
                reasons.append("太陽本身可能被低雲擋住，但上方中高雲仍可能被點亮（滿天橘色甚至火燒）")
            else:
                reasons.append("太陽本身可能被低雲擋住；上方中高雲少，色彩有限")

    # 觸發加成：作用於 C+D 合計，單日上限 +25
    bonus = 0.0
    if inp.burned_yesterday:
        bonus += BONUS_BURNED_YESTERDAY
        reasons.append(f"昨日實際有燒 → 持續性加成 +{BONUS_BURNED_YESTERDAY:.0f}（來源：結果日誌）")
    if inp.rain_clearing:
        bonus += BONUS_RAIN_CLEARING
        reasons.append(f"雨後放晴（12–17 時有雨、17 時後停）→ 加成 +{BONUS_RAIN_CLEARING:.0f}")
    if inp.front_within_48h:
        bonus += BONUS_FRONT
        reasons.append(f"鋒面／颱風外圍 48h 內（人工 flag）→ 加成 +{BONUS_FRONT:.0f}")
    if bonus > BONUS_DAILY_CAP:
        reasons.append(f"加成合計 {bonus:.0f} 超過單日上限，夾至 +{BONUS_DAILY_CAP:.0f}")
        bonus = BONUS_DAILY_CAP
    if bonus > 0:
        probs, moved = _transfer_to_cd(probs, bonus, a_floor=a_floor)
        if moved < bonus:
            reasons.append(f"A/B 可移轉空間不足，實際加成 +{moved:.0f}")

    # 防過度悲觀條款：cloud_high ≥ 20 時 C+D 不得低於 15%
    if inp.cloud_high >= ANTI_PESSIMISM_HIGH_MIN:
        cd = probs[2] + probs[3]
        if cd < ANTI_PESSIMISM_CD_FLOOR:
            need = ANTI_PESSIMISM_CD_FLOOR - cd
            probs, moved = _transfer_to_cd(probs, need, a_floor=a_floor)
            reasons.append(
                f"防過度悲觀條款：高雲 {inp.cloud_high:.0f}% ≥ {ANTI_PESSIMISM_HIGH_MIN:.0f}%，"
                f"C+D 拉回至 {ANTI_PESSIMISM_CD_FLOOR:.0f}%（穩定炎熱天照樣能燒）"
            )

    total = sum(probs)
    probs = [p * 100.0 / total for p in probs]
    return ScenarioProbs(
        a=probs[0], b=probs[1], c=probs[2], d=probs[3], reasons=tuple(reasons)
    )
