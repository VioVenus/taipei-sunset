// logs.js 測試：排程遲到產生的「日落後預測」不得進入週報對帳（對齊 leadtime.py）。
import assert from "node:assert/strict";
import test from "node:test";
import { rowIsTimely, weeklyStats } from "../js/logs.js";

const JIANTAN = { jiantan_laodifang: [25.0904311, 121.5367826] };
const row = (at, extra = {}) => ({
  predicted_at_utc: at, target_date: "2026-10-04", viewpoint_id: "jiantan_laodifang",
  prob_C: "24", prob_D: "16", verdict: "出發", ...extra,
});
const AT_1620 = "2026-10-04T08:20:00+00:00"; // 台北 16:20，日落約 17:40
const AT_2207 = "2026-10-04T14:07:00.123456+00:00"; // 實際發生過的遲到時間（含微秒）

test("rowIsTimely：日落前 ≥60 分鐘才有效", () => {
  assert.equal(rowIsTimely(row(AT_1620), JIANTAN), true);
  assert.equal(rowIsTimely(row(AT_2207), JIANTAN), false);
  assert.equal(rowIsTimely(row("2026-10-04T09:00:00+00:00"), JIANTAN), false); // 17:00，差 40 分
});

test("rowIsTimely：未建檔點位退回參考座標、壞資料視為無效", () => {
  assert.equal(rowIsTimely(row(AT_1620, { viewpoint_id: "nope" })), true);
  assert.equal(rowIsTimely({ predicted_at_utc: "garbage", target_date: "x" }), false);
});

test("weeklyStats：較晚的日落後列不得蓋過當天有效預測", () => {
  const preds = [row(AT_1620), row(AT_2207, { prob_C: "3", prob_D: "2", verdict: "跳過" })];
  const s = weeklyStats("2026-10-04", preds, [], JIANTAN);
  const today = s.days[s.days.length - 1];
  assert.equal(today.verdict, "出發");
  assert.equal(today.predictedCd, 40);
});
