// 評分引擎 v1 —— 從 src/sunset/scoring.py 逐式移植。
// Python 為 canonical：常數與流程不得在此單方面更動（parity 測試會擋）。

// v1.2.0：評估窗口改以實際日落時刻為中心（見 weather.js）；機率分配規則與 v1.0.0 相同。
// v1.1.0：動態不確定性區間（多模式分歧 → 區間加寬）。
export const ENGINE_VERSION = "v1.2.0";

export const LOW_CLEAR_MAX = 30.0;
export const MID_HIGH_IDEAL_MIN = 30.0;
export const MID_HIGH_IDEAL_MAX = 70.0;
export const BASE_IDEAL = [15.0, 25.0, 35.0, 25.0];
export const BASE_TOO_CLEAN = [10.0, 60.0, 22.0, 8.0];
export const BASE_TOO_THICK = [25.0, 35.0, 28.0, 12.0];
export const LOW_INTERFERENCE_MIN = 30.0;
export const LOW_INTERFERENCE_MAX = 70.0;
export const LOW_INTERFERENCE_SHIFT = 20.0;
export const DEATH_LOW_CLOUD = 70.0;
export const DEATH_PRECIP_PROB = 60.0;
export const DEATH_A_FLOOR = 60.0;
export const DEATH_A_CAP = 90.0;
export const DEATH_REMAINDER_RATIO = [5.0, 3.0, 2.0];
export const BONUS_BURNED_YESTERDAY = 15.0;
export const BONUS_RAIN_CLEARING = 20.0;
export const BONUS_FRONT = 10.0;
export const BONUS_DAILY_CAP = 25.0;
export const ANTI_PESSIMISM_HIGH_MIN = 20.0;
export const ANTI_PESSIMISM_CD_FLOOR = 15.0;
export const PROB_INTERVAL_HALF_WIDTH = 10.0;
export const PROB_INTERVAL_MAX_HALF_WIDTH = 25.0;
export const INTERVAL_SPREAD_THRESHOLD = 10.0;
export const INTERVAL_SPREAD_FACTOR = 0.5;

/** 多模式分歧 → 區間半寬（與 Python scoring.dynamic_half_width 同規則）。 */
export function dynamicHalfWidth(modelSpread) {
  if (modelSpread === null || modelSpread === undefined) return PROB_INTERVAL_HALF_WIDTH;
  const widened =
    PROB_INTERVAL_HALF_WIDTH +
    INTERVAL_SPREAD_FACTOR * Math.max(0, modelSpread - INTERVAL_SPREAD_THRESHOLD);
  return Math.min(PROB_INTERVAL_MAX_HALF_WIDTH, Math.max(PROB_INTERVAL_HALF_WIDTH, widened));
}

/** 點估 → [lo, hi] 區間（±halfWidth，夾在 0–100）。 */
export function probInterval(point, halfWidth) {
  const hw = halfWidth === null || halfWidth === undefined ? PROB_INTERVAL_HALF_WIDTH : halfWidth;
  const lo = Math.max(0, point - hw);
  const hi = Math.min(100, point + hw);
  return [Math.round(lo), Math.round(hi)];
}

function transferToCd(probs, amount, aFloor = 0) {
  const [a, b, c, d] = probs;
  const availA = Math.max(0, a - aFloor);
  const availB = Math.max(0, b);
  const pool = availA + availB;
  const moved = Math.min(amount, pool);
  if (moved <= 0 || pool <= 0) return { probs: [a, b, c, d], moved: 0 };
  const takeA = (moved * availA) / pool;
  const takeB = (moved * availB) / pool;
  const cd = c + d;
  const addC = cd > 0 ? (moved * c) / cd : moved / 2;
  const addD = moved - addC;
  return { probs: [a - takeA, b - takeB, c + addC, d + addD], moved };
}

/**
 * 規則引擎 v1。
 * @param {{cloudLow:number, cloudMid:number, cloudHigh:number,
 *          precipProbEvening?:number, burnedYesterday?:boolean,
 *          rainClearing?:boolean, frontWithin48h?:boolean}} inp
 */
export function score(inp) {
  const reasons = [];
  const low = inp.cloudLow;
  const mid = inp.cloudMid;
  const high = inp.cloudHigh;
  const precip = inp.precipProbEvening ?? 0;
  const midHigh = Math.max(mid, high);
  reasons.push(
    `低雲 ${low.toFixed(0)}%／中雲 ${mid.toFixed(0)}%／高雲 ${high.toFixed(0)}%` +
      `（mid_high = ${midHigh.toFixed(0)}%）`,
  );

  const death = low > DEATH_LOW_CLOUD || precip > DEATH_PRECIP_PROB;
  let aFloor = 0;
  let probs;

  if (death) {
    let severity = 0;
    if (low > DEATH_LOW_CLOUD) {
      severity = Math.max(severity, low);
      reasons.push(`💀 死亡條款：低雲 ${low.toFixed(0)}% > ${DEATH_LOW_CLOUD.toFixed(0)}%`);
    }
    if (precip > DEATH_PRECIP_PROB) {
      severity = Math.max(severity, precip);
      reasons.push(
        `💀 死亡條款：18–19 時降雨機率 ${precip.toFixed(0)}% > ${DEATH_PRECIP_PROB.toFixed(0)}%`,
      );
    }
    const a = Math.min(Math.max(DEATH_A_FLOOR, severity), DEATH_A_CAP);
    const remainder = 100 - a;
    const ratioSum = DEATH_REMAINDER_RATIO.reduce((s, v) => s + v, 0);
    probs = [
      a,
      (remainder * DEATH_REMAINDER_RATIO[0]) / ratioSum,
      (remainder * DEATH_REMAINDER_RATIO[1]) / ratioSum,
      (remainder * DEATH_REMAINDER_RATIO[2]) / ratioSum,
    ];
    aFloor = DEATH_A_FLOOR;
  } else {
    if (low < LOW_CLEAR_MAX && midHigh >= MID_HIGH_IDEAL_MIN && midHigh <= MID_HIGH_IDEAL_MAX) {
      probs = [...BASE_IDEAL];
      reasons.push("理想帶：低雲有縫且中高雲量適中（有燃料、不悶死）");
    } else if (midHigh < MID_HIGH_IDEAL_MIN) {
      probs = [...BASE_TOO_CLEAN];
      reasons.push("中高雲偏少，天太乾淨，偏向普通橘色夕陽");
    } else if (midHigh > MID_HIGH_IDEAL_MAX) {
      probs = [...BASE_TOO_THICK];
      reasons.push("中高雲太厚，光可能穿不透");
    } else {
      probs = [...BASE_IDEAL];
      reasons.push("中高雲量適中（有燃料）");
    }

    if (low >= LOW_INTERFERENCE_MIN && low <= LOW_INTERFERENCE_MAX) {
      const bcd = probs[1] + probs[2] + probs[3];
      const take = Math.min(LOW_INTERFERENCE_SHIFT, bcd);
      probs = [
        probs[0] + take,
        probs[1] - (take * probs[1]) / bcd,
        probs[2] - (take * probs[2]) / bcd,
        probs[3] - (take * probs[3]) / bcd,
      ];
      reasons.push(`低雲干擾（${low.toFixed(0)}%）：向 A 移轉 ${take.toFixed(0)} 個百分點`);
    }
  }

  let bonus = 0;
  if (inp.burnedYesterday) {
    bonus += BONUS_BURNED_YESTERDAY;
    reasons.push(`昨日實際有燒 → 持續性加成 +${BONUS_BURNED_YESTERDAY.toFixed(0)}（來源：結果日誌）`);
  }
  if (inp.rainClearing) {
    bonus += BONUS_RAIN_CLEARING;
    reasons.push(`雨後放晴（12–17 時有雨、17 時後停）→ 加成 +${BONUS_RAIN_CLEARING.toFixed(0)}`);
  }
  if (inp.frontWithin48h) {
    bonus += BONUS_FRONT;
    reasons.push(`鋒面／颱風外圍 48h 內（人工 flag）→ 加成 +${BONUS_FRONT.toFixed(0)}`);
  }
  if (bonus > BONUS_DAILY_CAP) {
    reasons.push(`加成合計 ${bonus.toFixed(0)} 超過單日上限，夾至 +${BONUS_DAILY_CAP.toFixed(0)}`);
    bonus = BONUS_DAILY_CAP;
  }
  if (bonus > 0) {
    const r = transferToCd(probs, bonus, aFloor);
    probs = r.probs;
    if (r.moved < bonus) reasons.push(`A/B 可移轉空間不足，實際加成 +${r.moved.toFixed(0)}`);
  }

  if (high >= ANTI_PESSIMISM_HIGH_MIN) {
    const cd = probs[2] + probs[3];
    if (cd < ANTI_PESSIMISM_CD_FLOOR) {
      const r = transferToCd(probs, ANTI_PESSIMISM_CD_FLOOR - cd, aFloor);
      probs = r.probs;
      reasons.push(
        `防過度悲觀條款：高雲 ${high.toFixed(0)}% ≥ ${ANTI_PESSIMISM_HIGH_MIN.toFixed(0)}%，` +
          `C+D 拉回至 ${ANTI_PESSIMISM_CD_FLOOR.toFixed(0)}%（穩定炎熱天照樣能燒）`,
      );
    }
  }

  const total = probs.reduce((s, v) => s + v, 0);
  probs = probs.map((p) => (p * 100) / total);
  return {
    a: probs[0],
    b: probs[1],
    c: probs[2],
    d: probs[3],
    reasons,
    engineVersion: ENGINE_VERSION,
    sunsetVisible: probs[1] + probs[2] + probs[3],
    burnLevel: probs[2] + probs[3],
  };
}
