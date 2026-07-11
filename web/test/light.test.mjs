// 光線相位引擎測試：邊界正確、餘燼窗口涵蓋日落後至藍調終。
import { test } from "node:test";
import assert from "node:assert/strict";
import { lightPhase, minutesUntil } from "../js/light.js";

// 台北夏季典型：黃金 17:55、日落 18:47、藍調終 19:13（以 epoch 分鐘簡化）
const M = 60000;
const sun = { goldenStartMs: 1075 * M, sunsetMs: 1127 * M, civilTwilightEndMs: 1153 * M };

test("day before golden start", () => {
  const r = lightPhase(sun, 980 * M); // 16:20
  assert.equal(r.key, "day");
  assert.equal(r.untilMs, sun.goldenStartMs);
  assert.equal(r.progress, null);
});

test("golden hour between golden start and sunset", () => {
  const r = lightPhase(sun, 1100 * M);
  assert.equal(r.key, "golden");
  assert.equal(r.untilMs, sun.sunsetMs);
  assert.ok(r.progress > 0 && r.progress < 1);
});

test("afterglow window: sunset (inclusive) to civil end", () => {
  assert.equal(lightPhase(sun, sun.sunsetMs).key, "afterglow"); // 日落瞬間即進入
  const mid = lightPhase(sun, 1140 * M);
  assert.equal(mid.key, "afterglow");
  assert.equal(mid.untilMs, sun.civilTwilightEndMs);
});

test("night at/after civil twilight end", () => {
  const r = lightPhase(sun, sun.civilTwilightEndMs);
  assert.equal(r.key, "night");
  assert.equal(r.untilMs, null);
});

test("minutesUntil never negative", () => {
  assert.equal(minutesUntil(90 * M, 0), 90);
  assert.equal(minutesUntil(0, 5 * M), 0);
});
