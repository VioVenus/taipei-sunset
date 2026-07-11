// i18n 測試：三語 key 集合一致（防漏翻）、插值、缺 key 退回 zh。
import { test } from "node:test";
import assert from "node:assert/strict";
import { t, _dicts } from "../js/i18n.js";

function keysOf(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...keysOf(v, key));
    else out.push(key);
  }
  return out.sort();
}

test("en/es cover exactly the same keys as zh (no missing translations)", () => {
  const d = _dicts();
  const zh = keysOf(d.zh);
  assert.deepEqual(keysOf(d.en), zh, "en keys differ from zh");
  assert.deepEqual(keysOf(d.es), zh, "es keys differ from zh");
});

test("interpolation fills variables", () => {
  const s = t("locate.found", { name: "高美濕地", km: 3 });
  assert.ok(s.includes("高美濕地") && s.includes("3"));
});

test("missing key returns the key itself (visible during dev)", () => {
  assert.equal(t("no.such.key"), "no.such.key");
});

test("array values pass through (weekdays)", () => {
  const wd = t("weekdays");
  assert.equal(wd.length, 7);
});
