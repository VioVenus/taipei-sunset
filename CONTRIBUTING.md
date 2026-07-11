# 參與指南

這是單人維護的興趣專案。歡迎回報與貢獻；回覆週期以週計，請見諒。

## 授權與貢獻條款

本專案採**非商業授權**（見 [LICENSE](LICENSE)），著作權屬 VioVenus。
提交任何貢獻（回報、Issue、PR、點位資料）即表示你同意：

1. 你的貢獻以與本專案相同之條款授權，並授予維護者永久、不可撤銷之
   使用、修改、公開與再授權權利（讓專案未來調整授權時不需逐一回頭取得同意）；
2. 回報內容（結果等級、備註、GitHub 帳號名）會公開保存於日誌並用於校準；
3. 你的貢獻是你自己的創作，或你有權以此條款提供。

## 我看完日落想回報結果

最快的路：開 PWA →「紀錄」分頁 → 按 A/B/C/D → 在開啟的 GitHub 表單按 Submit。
或直接開 [回報 Issue](../../issues/new?template=outcome_report.yml)。

規則：同一人同一天只採計最新一筆；多人回報以多數決聚合；只收今天/昨天的回報。
你的 GitHub 帳號名與備註會公開記錄在 `data/logs/reports.csv`。

## 我想提議新觀景點位

開 [點位提議](../../issues/new?template=new_viewpoint.yml)。**入庫是人工流程**
（歷史教訓 1：座標禁止臨場猜測），維護者驗證清單：

- [ ] 座標經現場 GPS 確認（非地圖目測）
- [ ] 開闊視線方位範圍經指北針/App 現場實測
- [ ] 遮蔽物方位與仰角有目測記錄
- [ ] 交通與退場方式可行（傍晚時段安全）
- [ ] 幾何驗算：日落方位對位、遮蔽→提前沒入分鐘數合理

自己動手更快：附上述資料直接開 PR 改 `data/viewpoints.json`。

## 我覺得預測不準

先問自己：那天你回報結果了嗎？沒有回報的日子無法進入校準。
然後開 [產品回饋](../../issues/new?template=feedback.yml) 附上日期。

**規則常數不會因單一回饋而改**：任何評分規則變動需引用日誌統計（樣本 ≥60 天），
並 bump `ENGINE_VERSION` + 重生成 parity fixtures。這是防過度擬合的紀律，不是固執。

## 我想改程式

- Python（`src/sunset/`）是規則的 canonical；JS（`web/js/`）是移植。
  兩邊都改，並跑 `python scripts/gen_parity_fixtures.py && node --test web/test/parity.test.mjs`
- 送 PR 前：`pytest && ruff check .` 全綠
- 日誌是 append-only：任何 PR 不得改寫 `data/logs/` 既有列

## 維護節奏

- 結果回報：機器人全自動處理
- 其他 issue：每週日與週報一起 triage（標籤：`confirmed-bug` / `rule-tuning` / `wontfix`）
- `rule-tuning` 只進 Phase 2 校準待辦，不即時改規則
