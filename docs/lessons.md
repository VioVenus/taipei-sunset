# 歷史教訓（與程式中的落實機制對照）

這五條教訓是系統設計的硬約束。任何改動若違反其中一條，先回來讀這份文件。

## 1. 幾何座標一律來自建檔資料，禁止臨場猜測

新點位必須人工確認座標與視線方位後才入庫（`data/viewpoints.json`）。

**程式落實**：`geometry.load_viewpoints()` 是唯一的座標來源；`solar` / `analysis`
所有幾何計算只吃 `Viewpoint` dataclass，程式中沒有任何硬編碼座標。
測試以實測驗證值鎖定種子資料（劍潭山→觀音山 255°/11.1km）。

## 2. 「多雲」不代表會燒 —— 分層雲量驅動

低雲（<2000m）擋太陽；只有中高雲會被日落點燃。總雲量僅作參考顯示。

**程式落實**：`weather.WeatherWindow` 強制取得 `cloud_cover_low / mid / high`
三層雲量（任一層缺值即降級為「資料不足」）；`scoring.score()` 的所有規則
以 `cloud_low` 與 `mid_high = max(cloud_mid, cloud_high)` 為輸入，
`cloud_total` 不參與評分。

## 3. 「穩定炎熱天照樣能燒」—— 防過度悲觀條款（5/25 教訓）

即使高溫穩定、無鋒面，只要高雲存在就有燒的可能。

**程式落實**：`scoring.py` 防過度悲觀條款 —— `cloud_high ≥ 20` 時
C+D 合計不得低於 15%（常數 `ANTI_PESSIMISM_HIGH_MIN` / `ANTI_PESSIMISM_CD_FLOOR`），
在所有規則（含死亡條款）之後最後套用。

## 4. 火燒雲常連日出現 —— 持續性加成

昨天有燒，今天燒的機率明顯升高（24–48h 持續性）。

**程式落實**：`scoring` 的 `burned_yesterday` 加成 +15（作用於 C+D）。
資料來源是 `logbook.burned_on()` 讀 `outcomes.csv` 中**昨日的實際回報**
（C 或 D 才算有燒）——不是昨天的預測。沒有回報就沒有加成，
所以每天 19:15 的 `/report` 回報很重要。

## 5. 早上的預報對午後對流幾乎無鑑別力

台北夏季午後對流是預報最大的雜訊來源，早上的模式輸出無法分辨。

**程式落實**：
- 16:20 判定（`push-daily`）一律在執行當下重新打 API，用最新一次預報資料。
- 中午前查詢（或查詢未來日期）時，`analysis` 標記 `preliminary=True`，
  訊息附註「初步展望，信心低，以當日 16:20 推播為準」。
- 校準時只用「當日最後一次 16:20 前後的預測」對 outcome（見 logbook 註解）。

## 附：資料來源紀律

- 禁止爬任何天氣網頁 HTML（歷史教訓：Yahoo 氣象網頁回傳過期快取），
  一律走結構化 API（Open-Meteo 主力、CWA 開放資料交叉驗證）。
- 所有 fetch 加 timeout、重試一次，失敗時降級輸出「資料不足」而非崩潰。
- 預測日誌 append-only、point-in-time：寫入後永不修改，
  任何規則常數變動都要 bump `ENGINE_VERSION`。
