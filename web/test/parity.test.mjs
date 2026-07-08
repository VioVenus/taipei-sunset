// JS ↔ Python parity 測試：Python 產生 fixtures（canonical），JS 移植必須吻合。
// 執行：node --test web/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  sunsetTimeMs,
  sunsetAzimuth,
  goldenHourStartMs,
  civilTwilightEndMs,
} from "../js/solar.js";
import { bearingDeg, distanceKm } from "../js/geometry.js";
import { score, ENGINE_VERSION, dynamicHalfWidth } from "../js/scoring.js";

const fixtures = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures.json"), "utf-8"),
);

test("engine version matches fixtures", () => {
  assert.equal(ENGINE_VERSION, fixtures.engine_version);
});

test("solar parity: sunset/golden/civil within 2s, azimuth within 0.05°", () => {
  for (const f of fixtures.solar) {
    const label = `${f.date} ${f.site}`;
    assert.ok(Math.abs(sunsetTimeMs(f.date, f.lat, f.lon) - f.sunset_ms) < 2000, `${label} sunset`);
    assert.ok(Math.abs(sunsetAzimuth(f.date, f.lat, f.lon) - f.azimuth) < 0.05, `${label} azimuth`);
    assert.ok(
      Math.abs(goldenHourStartMs(f.date, f.lat, f.lon) - f.golden_ms) < 2000,
      `${label} golden`,
    );
    assert.ok(
      Math.abs(civilTwilightEndMs(f.date, f.lat, f.lon) - f.civil_ms) < 2000,
      `${label} civil`,
    );
  }
});

test("geometry parity: bearing within 0.01°, distance within 1m", () => {
  for (const f of fixtures.geometry) {
    assert.ok(Math.abs(bearingDeg(...f.from, ...f.to) - f.bearing) < 0.01, `${f.name} bearing`);
    assert.ok(Math.abs(distanceKm(...f.from, ...f.to) - f.distance_km) < 0.001, `${f.name} dist`);
  }
});

test("interval parity: dynamic half width", () => {
  for (const f of fixtures.interval) {
    const got = dynamicHalfWidth(f.spread);
    assert.ok(Math.abs(got - f.half_width) < 1e-9, `spread=${f.spread} got=${got} want=${f.half_width}`);
  }
});

test(`scoring parity: ${fixtures.scoring.length} cases within 1e-6`, () => {
  for (const f of fixtures.scoring) {
    const [low, mid, high, precip, burned, rain, front] = f.in;
    const p = score({
      cloudLow: low,
      cloudMid: mid,
      cloudHigh: high,
      precipProbEvening: precip,
      burnedYesterday: Boolean(burned),
      rainClearing: Boolean(rain),
      frontWithin48h: Boolean(front),
    });
    const got = [p.a, p.b, p.c, p.d];
    f.out.forEach((expected, i) => {
      assert.ok(
        Math.abs(got[i] - expected) < 1e-6,
        `in=${JSON.stringify(f.in)} idx=${i} got=${got[i]} want=${expected}`,
      );
    });
    assert.ok(Math.abs(p.a + p.b + p.c + p.d - 100) < 1e-9, "sum=100");
  }
});
