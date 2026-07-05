# 原生 App 規劃 v2（依 UX 審查修訂）

取代 uiux.md 附錄 A。前提：PWA 已依 [ux-review.md](ux-review.md) 改善完畢，
以下規劃只處理 **PWA 原理上做不到** 的事，不重做已被 PWA 覆蓋的功能。

---

## 1. 差距分析：PWA 之後還剩什麼？

| 需求 | PWA 現狀 | 原生能解 | 對本產品的實際價值 |
|---|---|---|---|
| 系統級推播（16:20/19:15/週報） | 靠 ntfy app（穩定但是另一個 app） | 同一 app 內收推播（FCM/APNs） | **中**：消除「多裝一個 app」的摩擦 |
| 桌面 Widget（今晚判定不點開就看到） | ❌ 不可能 | WidgetKit / Glance | **高**：把「3 秒決策」變成「0 秒」 |
| 鎖屏即時活動（黃金時段倒數進度） | ❌ | iOS Live Activities | **高**（出發後的現場價值） |
| AR 方位對照（舉起手機看日落點） | 羅盤 SVG（平面） | ARKit/相機疊加 | 中（攝影 persona） |
| 接近點位自動提醒（背景定位） | ❌ | 背景地理圍欄 | 低（單人使用，路線固定） |
| 離線查詢/回報 | ✅ 已覆蓋 | — | — |
| 一鍵回報 | ✅ 已覆蓋（token + dispatch） | 原生可加通知內快捷回覆按鈕 | 中：19:15 通知上直接按 A–D，回報摩擦歸零 |

**修訂後的核心論點**：原生的價值不在「把 PWA 包起來」，而在
**Widget、Live Activity、通知快捷回覆** 這三件 PWA 永遠做不到的事。
規劃因此從「Capacitor 包殼」改為「包殼只是載體，原生擴充點才是目的」。

## 2. 分階段路線（每階段有明確觸發條件，未觸發不做）

### N0（現狀）：PWA + ntfy —— 預設停留點
維運成本 0。**觸發離開 N0 的條件**：連續兩週以上，實際感到
「還要開 ntfy／還要點開 app 看判定」構成真實摩擦，而非想像需求。

### N1：Android APK（Capacitor 包殼 + FCM + Widget）
- **內容**：`npx cap add android` 包現有 web/；FCM 推播（notify.py 加 FCMChannel，
  金鑰進 GitHub Secrets）；Glance 小工具讀每日預測 JSON（Actions 產出
  `data/latest.json` 供 widget 拉取）；通知加 A–D 快捷回覆按鈕 → 打 workflow_dispatch。
- **成本**：無商店費（sideload APK，Actions 直接 build 產出 artifact）；
  一次性 Firebase 專案設定；估 2–3 個工作天。
- **觸發條件**：主要手機是 Android。
- **不變式**：UI 仍是同一份 web/（WebView），評分引擎不出現第三份實作。

### N2：iOS（Capacitor + APNs + TestFlight）
- **內容**：同 N1 架構 + APNs；發佈走 TestFlight（個人使用免上架審查壓力，
  90 天有效期需重推，用 Actions 自動化 `fastlane pilot`）。
- **成本**：Apple Developer **USD 99/年** + 簽章維護 + 每年跟 Xcode 版本；
  估 3–5 個工作天起。
- **觸發條件**：主要手機是 iPhone **且** N0 摩擦條件成立 **且**
  接受年費；三者缺一不做。

### N3：原生獨有價值層（在 N1/N2 殼上加原生 target）
優先序依 UX 審查的 persona 價值排序：
1. **Widget**（Android Glance / iOS WidgetKit）：顯示今晚判定字＋火燒雲區間＋日落時刻，
   資料源 = Actions 每日 commit 的 `latest.json`（point-in-time，不在裝置上重算）。
2. **iOS Live Activity**：16:20 判定「出發」後可啟動，鎖屏顯示
   黃金時段→日落→藍調倒數進度條（資料全本地太陽幾何，無網路依賴）。
3. **通知快捷回覆**（N1/N2 內建做掉）。
4. AR 方位對照：需求證實後才評估（PhotoPills 已存在，先用現成品）。

### 明確不做
- 公開上架 App Store / Play Store（審核、隱私聲明、跟版成本對單人工具不成比例）。
- 重寫 UI 成 SwiftUI/Compose（違反單一 UI 資產原則）。
- watchOS/Wear（等 Widget 用一季後再評估是否真的需要）。

## 3. 架構不變式（所有階段適用）

```
Python (src/sunset)        ← canonical：規則、常數、engine_version
   │  gen_parity_fixtures
   ▼
JS core (web/js)           ← 唯一移植，CI parity 擋漂移
   │  同一份資產
   ├── PWA（GitHub Pages）
   └── Capacitor WebView（N1/N2 殼）
        └── 原生 target 只做：推播接收、Widget、Live Activity、快捷回覆
            （只「顯示」Actions 產出的結果，絕不在裝置上重算評分）
```

- 推播發送端維持 GitHub Actions（cron）；notify.py 是唯一發送介面，
  加 channel 不改流程。
- 日誌紀律不變：所有寫入走 workflow_dispatch → git commit（append-only）。

## 4. 風險與退場

| 風險 | 緩解 |
|---|---|
| Apple 年費付了但用不到 N3 價值 | 先做 N1（免費）驗證 Widget/快捷回覆的真實使用率，再決定 N2 |
| Capacitor/OS 升級跟版 | 殼內容極薄（WebView + 3 個原生點），跟版面積小 |
| FCM/APNs 金鑰管理 | 全走 GitHub Secrets，與現有 Telegram/ntfy 同一套紀律 |
| TestFlight 90 天過期 | fastlane 自動重推（月排程 Action） |

## 5. 建議（一句話）

**留在 N0，直到「還要開 ntfy」真的煩到你**；Android 用戶煩了走 N1（免費、三天、
拿到 Widget＋通知快捷回報），iPhone 用戶煩了才考慮 N2＋N3（年費 99 鎂買
Widget＋Live Activity，值不值由使用頻率決定，不是由工程熱情決定）。
