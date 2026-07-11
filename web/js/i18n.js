// 三語系（繁中/英/西）字典與切換。零依賴；zh 為正本，缺 key 時退回 zh。
// UX writing 原則：口語、短句、行動導向；專有名詞（點位名、備註資料）保留原文。

export const LANGS = [
  { code: "zh", label: "中文" },
  { code: "en", label: "EN" },
  { code: "es", label: "ES" },
];

const LANG_KEY = "sunset.lang";

const STRINGS = {
  zh: {
    appTitle: "台灣日落",
    sunsetWord: "日落",
    nav: { forecast: "預報", log: "紀錄", settings: "設定" },
    chips: { today: "今天", tomorrow: "明天", dayAfter: "後天", plus3: "+3天" },
    weekdays: ["日", "一", "二", "三", "四", "五", "六"],
    banner: {
      preliminary: "📌 初步展望・信心低，以當日 16:20 推播為準（早上的預報對午後對流幾乎無鑑別力）",
      stale: "⚠️ 離線快取資料（{time} 取得），僅供參考",
    },
    verdict: { go: "出發", skip: "跳過", nodata: "資料不足" },
    vp: { recommend: "推薦 {name}", notIdealHere: "· 今晚此點不理想", notIdealRegion: "· 本區今晚各點都不理想" },
    summary: {
      noData: "拿不到天氣資料，僅顯示太陽時間表。",
      death: "低雲或降雨會全面遮擋，今晚基本上看不到。",
      idealGo: "雲況在理想帶：低雲有縫、中高雲有燃料，值得出門。",
      ideal: "雲況在理想帶：低雲有縫、中高雲有燃料。",
      tooClean: "天空太乾淨，多半只是普通橘色夕陽。",
      tooThick: "中高雲偏厚，夕陽光不一定穿得透。",
      neutralGo: "雲況中性，照機率決定。",
      neutralSkip: "雲況中性偏保守，這晚可以跳過。",
      lowCloud: "但低雲偏多是最大變數。",
      rainClear: "雨後放晴是加分項。",
    },
    countdown: {
      toSunset: "距日落 <b>{h} 小時 {m} 分</b>",
      leaveBy: "建議 <b>{time}</b> 前出發（路程約 {mins} 分，趕上黃金時段）",
      arriveAt: "現在出發約 <b>{time}</b> 抵達",
    },
    labels: { burn: "火燒雲（C+D）", visible: "看得到日落（B+C+D）", retry: "重試", fetchFail: "取得失敗" },
    actions: { navigate: "🧭 導航到{name}", share: "📤 分享判定", copied: "已複製到剪貼簿" },
    share: { line1: "{date} 日落判定：{verdict}・{name}", line2: "火燒雲 {interval}｜日落 {time}" },
    timeline: {
      title: "太陽時間軸", golden: "黃金起", effective: "有效沒入", sunset: "日落", blueEnd: "藍調終",
      azimuth: "日落方位 <b>{az}°</b>（橘針）",
      sector: "橘扇形＝開闊視線 {a}–{b}°，紅斑＝建檔遮蔽",
      obstruction: "遮蔽：{note}（仰角 {deg}° → 提前 {mins} 分鐘沒入）",
    },
    scenario: {
      title: "四情境機率",
      a: "A 擋光", b: "B 普通", c: "C 局部燒", d: "D 全面燒",
      helpTitle: "什麼是 A／B／C／D？",
      helpA: "<b>A 擋光</b>：低雲或降雨全面遮擋，什麼都看不到。",
      helpB: "<b>B 普通</b>：看得到太陽下山，普通橘色夕陽，無戲劇性。",
      helpC: "<b>C 局部燒</b>：部分天空被日落點燃（值得出門的門檻）。",
      helpD: "<b>D 全面燒</b>：整片天空燒起來（一年數次等級）。",
      interval: "機率一律顯示區間——預測本來就有不確定性，單點數字是假精確。",
      reasonsTitle: "理由",
      spreadNote: "多模式雲量分歧 {spread}%（{models}）→ 區間加寬至 ±{hw}",
      reasonsZhNote: "分析明細（中文原文）",
    },
    light: {
      now: "現在：{name}",
      untilNext: "距{next}",
      tipsTitle: "📸 這個時段怎麼拍／怎麼做",
      day: { name: "白天", heading: "距黃金時段還有一段時間", next: "黃金時段",
        tips: ["先看判定與雷達，決定要不要出門", "拍攝：這段光平淡，適合探點、找前景構圖"] },
      golden: { name: "黃金時段", heading: "低角度暖光進行中", next: "日落",
        tips: ["順光拍人像膚色最好；逆光試剪影＋星芒（縮光圈 f/11–16）", "測光對天空、對暗部補光或包圍曝光（±2EV）"] },
      afterglow: { name: "餘燼窗口", heading: "別走！火燒雲高峰常在日落後 10–20 分鐘", next: "藍調結束",
        tips: ["雲由金轉粉紅→紫紅是正要燒的訊號，再等 5 分鐘", "光線快速變暗：上腳架或提 ISO，白平衡固定「陰天」保留暖色"] },
      night: { name: "藍調結束", heading: "今晚的光已收場", next: "",
        tips: ["看明天：日落時刻與判定見上方日期切換", "剛拍完？回「紀錄」分頁回報 A–D，累積校準資料"] },
    },
    checklist: {
      goTitle: "出發前 60 秒確認", skipTitle: "不出門也能看：遠端看西天",
      goIntro: "預測給機率，眼睛做最後確認——這一步取代「16:30 抬頭看西天」。",
      skipIntro: "判定保守但天空偶爾會給驚喜——用即時影像瞄一眼西天，真的燒起來再衝也來得及。",
      step1: "雷達：有無回波正在移入（對流殘留）",
      step2: "即時影像：西邊天空低雲是否比預報厚",
      visibility: "能見度約 {km} km{warn}",
      visibilityWarn: "（偏低，霧霾會吃掉色彩層次）",
      live: "即時直播", liveUnverified: "即時直播・連結待驗證", openYt: "在 YouTube 開啟", unverified: "（待驗證）",
      playAria: "播放 {name} 即時影像",
    },
    others: { title: "同區其他點位", nodata: "資料不足", burnShort: "火燒雲 {interval}" },
    strip: { betterHint: "💡 明晚看起來更好（火燒雲 {interval}）——點「明天」看詳情" },
    region: { 北: "北部", 中: "中部", 南: "南部", 東: "東部", 離島: "離島" },
    locate: { btn: "📍 最近", ing: "定位中…", found: "最近點位：{name}（約 {km} km）",
      fail: "定位失敗或被拒；請用地區分頁手動選", noGeo: "此裝置不支援定位；請用地區分頁手動選" },
    onboard: {
      title: "👋 第一次來？30 秒看懂",
      b1: "「火燒雲」＝日落把雲燒成橘紅——本 app 每天預測今晚燒不燒、去哪看。",
      b2: "機率永遠是區間（如 40–60%）：預測本來就不確定，我們不假裝精確。",
      b3: "看完回報 A–D，預測會越來越準。",
      dismiss: "知道了",
    },
    log: {
      title: "今晚 {date} 實際結果？",
      context: "今天預測（{name}）：{verdict}・火燒雲 {interval}",
      mine: "✅ 你今天已回報：<b>{outcome}</b>（可再按其他鍵修改，只採計最新一筆）",
      oa: "全擋沒看到", ob: "普通橘色", oc: "局部火燒雲", od: "全面火燒雲",
      notePh: "備註（選填），例：西北側有燒約10分鐘",
      openForm: "已開啟回報表單（{outcome} 已預填）→ 按 Submit 即完成，機器人會自動記錄",
      confirm: "回報 {date} 實際結果為「{outcome}」？",
      sending: "送出中…", sent: "✅ 已送出（{outcome}），約 1–2 分鐘後寫入 outcomes.csv",
      sendFail: "❌ 送出失敗（HTTP {status}），請檢查 token 權限或改用 GitHub 頁面",
      explain: "你的回報會成為明天「昨日有燒」加成與長期校準的資料。多人回報以多數決聚合，同一人同一天只採計最新一筆（回報過可再改）。送出走 GitHub 表單，需 GitHub 帳號。",
      weeklyTitle: "本週統計",
      wPredicted: "預測 {p}/7 天｜結果回報 {r}/7 天",
      wGo: "判定「出發」{n} 天：已回報 {rep} 天中實際有燒 {burn} 天",
      wSkip: "判定「跳過」且有回報 {n} 天：錯過有燒 {miss} 天",
      wAvg: "預測 C+D 週平均 {v}%", wRate: "實際有燒比例 {v}%",
      wSample: "樣本未達 60 天：僅觀察陳述，不做調參。", wOffline: "（⚠️ 離線副本，可能過期）",
      histTitle: "歷史紀錄（近 7 天）",
      thDate: "日期", thVerdict: "判定", thPred: "預測C+D", thActual: "實際", thDir: "方向",
      dirTip: "預測方向（門檻25）與實際是否一致",
      notReported: "未回報", people: "（{n} 人）",
      dirNote: "方向 = 預測是否過出發門檻（C+D≥25）與實際有無燒一致；非正式校準（樣本滿 60 天才調參）。",
      empty: "尚無紀錄。今晚看完日落回報第一筆吧！",
    },
    settings: {
      installTitle: "📲 加入主畫面（當 app 用）",
      installIos: "<b>iPhone</b>：Safari 開本頁 → 分享 → 「加入主畫面」",
      installAndroid: "<b>Android</b>：Chrome 開本頁 → 選單 ⋮ → 「安裝應用程式」",
      installOffline: "安裝後離線也能看太陽時間表；天氣需連線",
      statusTitle: "資料狀態",
      stOpenMeteo: "Open-Meteo：{v}", stOk: "最近成功 {time}", stStale: "（目前離線快取）", stNone: "尚未取得",
      stLogs: "日誌來源：raw.githubusercontent.com（失敗退回站內副本）",
      stMode: "模式：{v}", stDemo: "DEMO（擬真資料）", stProd: "正式",
      stCredit: "天氣資料：<a href=\"https://open-meteo.com/\" target=\"_blank\" rel=\"noopener\">Open-Meteo</a>（CC BY 4.0）",
      stFeedback: "💬 回饋與建議（GitHub）",
      aboutTitle: "關於",
      aboutText: "評分引擎 {ver}｜規則常數與歷史教訓見 repo docs/。太陽幾何為本地計算（NOAA），離線可用。",
      aboutPara: "每日 16:20 推播與資料排程由 GitHub Actions 執行（通道與金鑰由維護者在 GitHub Secrets 設定，不在本頁）。本 app 為查詢、回報與回顧介面。機率一律為區間，禁止假精確。",
      copyright: "© 2026 VioVenus・非商業授權（詳見 repo LICENSE）",
      maintTitle: "🔧 維護者：GitHub 一鍵回報",
      maintDesc: "fine-grained token（只勾本 repo 的 Actions: Read and write），存在此裝置 localStorage。設定後「紀錄」頁回報改為直接觸發 workflow，不經表單。",
      save: "儲存", test: "測試連線", exitMaint: "離開維護者模式",
      saved: "已儲存於本機。", clearedTok: "已清除。", testing: "測試中…", maintOn: "🔧 維護者模式已開啟",
    },
    common: { language: "語言", hm: "{h} 小時 {m} 分", m: "{m} 分鐘", dataLine: "資料：{src}・{time} 取得｜評分引擎 {ver}", demoTag: "｜⚠️ DEMO 模式（擬真資料）", loading: "取得 Open-Meteo 天氣資料中…（逾時會自動降級）" },
  },

  en: {
    appTitle: "Taiwan Sunset",
    sunsetWord: "Sunset",
    nav: { forecast: "Forecast", log: "Report", settings: "Settings" },
    chips: { today: "Today", tomorrow: "Tmrw", dayAfter: "+2d", plus3: "+3d" },
    weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    banner: {
      preliminary: "📌 Early outlook, low confidence — the 4:20 pm update is the one to trust (morning models can't see afternoon storms)",
      stale: "⚠️ Offline cached data (from {time}) — reference only",
    },
    verdict: { go: "Go", skip: "Skip", nodata: "No data" },
    vp: { recommend: "Best pick: {name}", notIdealHere: "· not great here tonight", notIdealRegion: "· nowhere in this region looks good tonight" },
    summary: {
      noData: "Couldn't fetch weather — showing sun times only.",
      death: "Low cloud or rain will block everything. You won't see much tonight.",
      idealGo: "Clouds are in the sweet spot: gaps below, fuel above. Worth heading out.",
      ideal: "Clouds are in the sweet spot: gaps below, fuel above.",
      tooClean: "Sky's too clean — expect a plain orange sunset at best.",
      tooThick: "Mid/high clouds are thick; the light may not punch through.",
      neutralGo: "Middling clouds — go with the odds.",
      neutralSkip: "Middling clouds, leaning cautious — fine to sit this one out.",
      lowCloud: "Low cloud is the wild card, though.",
      rainClear: "Clearing after rain is a plus.",
    },
    countdown: {
      toSunset: "<b>{h} h {m} min</b> to sunset",
      leaveBy: "Leave by <b>{time}</b> ({mins} min trip — catches golden hour)",
      arriveAt: "Leave now, arrive around <b>{time}</b>",
    },
    labels: { burn: "Fire-sky (C+D)", visible: "Visible sunset (B+C+D)", retry: "Retry", fetchFail: "Fetch failed" },
    actions: { navigate: "🧭 Directions to {name}", share: "📤 Share", copied: "Copied to clipboard" },
    share: { line1: "{date} sunset call: {verdict} · {name}", line2: "Fire-sky {interval} | sunset {time}" },
    timeline: {
      title: "Sun timeline", golden: "Golden", effective: "Drops behind", sunset: "Sunset", blueEnd: "Blue hour ends",
      azimuth: "Sunset azimuth <b>{az}°</b> (orange needle)",
      sector: "Orange wedge = open view {a}–{b}°, red = known obstruction",
      obstruction: "Obstruction: {note} ({deg}° high → sun drops {mins} min early)",
    },
    scenario: {
      title: "Four outcomes",
      a: "A Blocked", b: "B Plain", c: "C Partial", d: "D Full burn",
      helpTitle: "What do A/B/C/D mean?",
      helpA: "<b>A Blocked</b>: low cloud or rain hides everything.",
      helpB: "<b>B Plain</b>: you see the sun set — ordinary orange, no drama.",
      helpC: "<b>C Partial burn</b>: part of the sky lights up (the go-out threshold).",
      helpD: "<b>D Full burn</b>: the whole sky on fire (a few times a year).",
      interval: "Odds are always shown as ranges — forecasts are uncertain, and a single number would be false precision.",
      reasonsTitle: "Why",
      spreadNote: "Models disagree on cloud by {spread}% ({models}) → range widened to ±{hw}",
      reasonsZhNote: "Full analysis details (Chinese)",
    },
    light: {
      now: "Now: {name}",
      untilNext: "{next} in",
      tipsTitle: "📸 What to do / shoot right now",
      day: { name: "Daytime", heading: "Still a while until golden hour", next: "golden hour",
        tips: ["Check the call and radar first, then decide", "Flat light — good for scouting spots and foregrounds"] },
      golden: { name: "Golden hour", heading: "Warm low-angle light in progress", next: "sunset",
        tips: ["Front-lit portraits glow; backlit, try silhouettes + sunstars (f/11–16)", "Meter for the sky; lift shadows or bracket ±2EV"] },
      afterglow: { name: "Afterglow window", heading: "Don't leave! Peak color usually hits 10–20 min after sunset", next: "blue hour end",
        tips: ["Gold turning pink → magenta means it's about to burn — give it 5 more minutes", "Light drops fast: tripod or raise ISO; lock white balance to Cloudy to keep the warmth"] },
      night: { name: "Blue hour over", heading: "Tonight's light show has ended", next: "",
        tips: ["Check tomorrow via the date tabs above", "Just shot it? Report A–D in the Report tab — it trains the forecast"] },
    },
    checklist: {
      goTitle: "60-second check before you go", skipTitle: "Watch from home: live west-sky views",
      goIntro: "The forecast gives odds; your eyes make the final call — this replaces 'look west at 4:30'.",
      skipIntro: "The call is cautious, but skies surprise — glance at the live cams, and if it lights up you can still make a run.",
      step1: "Radar: anything moving in? (leftover storms)",
      step2: "Live cams: is low cloud in the west thicker than forecast?",
      visibility: "Visibility ~{km} km{warn}",
      visibilityWarn: " (low — haze eats the colors)",
      live: "LIVE", liveUnverified: "LIVE · link unverified", openYt: "Open on YouTube", unverified: " (unverified)",
      playAria: "Play {name} live view",
    },
    others: { title: "Other spots nearby", nodata: "No data", burnShort: "Fire-sky {interval}" },
    strip: { betterHint: "💡 Tomorrow looks better (fire-sky {interval}) — tap “Tmrw” for details" },
    region: { 北: "North", 中: "Central", 南: "South", 東: "East", 離島: "Islands" },
    locate: { btn: "📍 Nearest", ing: "Locating…", found: "Nearest spot: {name} (~{km} km)",
      fail: "Location failed or denied — pick a region manually", noGeo: "No geolocation on this device — pick a region manually" },
    onboard: {
      title: "👋 First time? 30-second primer",
      b1: "“Fire-sky” = sunset setting the clouds ablaze. This app predicts, daily, whether tonight burns — and where to watch.",
      b2: "Odds are always ranges (e.g. 40–60%): forecasts are uncertain and we won't fake precision.",
      b3: "Report what you saw (A–D) afterwards — it makes the forecast smarter.",
      dismiss: "Got it",
    },
    log: {
      title: "How did {date} actually turn out?",
      context: "Today's call ({name}): {verdict} · fire-sky {interval}",
      mine: "✅ You reported <b>{outcome}</b> today (tap another to change — only the latest counts)",
      oa: "Blocked, saw nothing", ob: "Plain orange", oc: "Partial fire-sky", od: "Full fire-sky",
      notePh: "Note (optional), e.g. burned ~10 min in the NW",
      openForm: "Report form opened ({outcome} pre-filled) → hit Submit and the bot logs it",
      confirm: "Report {date} as “{outcome}”?",
      sending: "Sending…", sent: "✅ Sent ({outcome}) — lands in outcomes.csv in 1–2 min",
      sendFail: "❌ Failed (HTTP {status}) — check token permissions or use the GitHub form",
      explain: "Your report feeds tomorrow's “burned yesterday” bonus and long-term calibration. Multiple reports are merged by majority; per person per day, only the latest counts (you can change yours). Submitting uses a GitHub form — account required.",
      weeklyTitle: "This week",
      wPredicted: "Forecasts {p}/7 days | reports {r}/7 days",
      wGo: "“Go” called {n} days: of {rep} reported, {burn} actually burned",
      wSkip: "“Skip” with reports {n} days: missed {miss} burns",
      wAvg: "Avg predicted C+D {v}%", wRate: "Actual burn rate {v}%",
      wSample: "Under 60 days of data: observations only, no tuning yet.", wOffline: "(⚠️ offline copy, may be stale)",
      histTitle: "History (last 7 days)",
      thDate: "Date", thVerdict: "Call", thPred: "Pred. C+D", thActual: "Actual", thDir: "Hit",
      dirTip: "Did the call (threshold 25) match what happened?",
      notReported: "no report", people: " ({n} people)",
      dirNote: "Hit = whether the forecast cleared the go-threshold (C+D≥25) matches whether it actually burned. Informal — real tuning waits for 60 days of data.",
      empty: "Nothing yet. Watch tonight's sunset and file the first report!",
    },
    settings: {
      installTitle: "📲 Add to home screen",
      installIos: "<b>iPhone</b>: open in Safari → Share → “Add to Home Screen”",
      installAndroid: "<b>Android</b>: open in Chrome → menu ⋮ → “Install app”",
      installOffline: "Installed, sun times work offline; weather needs a connection",
      statusTitle: "Data status",
      stOpenMeteo: "Open-Meteo: {v}", stOk: "last success {time}", stStale: " (using offline cache)", stNone: "not fetched yet",
      stLogs: "Logs: raw.githubusercontent.com (falls back to bundled copy)",
      stMode: "Mode: {v}", stDemo: "DEMO (simulated data)", stProd: "live",
      stCredit: "Weather: <a href=\"https://open-meteo.com/\" target=\"_blank\" rel=\"noopener\">Open-Meteo</a> (CC BY 4.0)",
      stFeedback: "💬 Feedback & ideas (GitHub)",
      aboutTitle: "About",
      aboutText: "Scoring engine {ver} | rules & field lessons in repo docs/. Sun geometry computed locally (NOAA) — works offline.",
      aboutPara: "The 4:20 pm push and data jobs run on GitHub Actions (channels & keys live in GitHub Secrets, not here). This app is for checking, reporting, and reviewing. Odds are always ranges — no false precision.",
      copyright: "© 2026 VioVenus · Non-commercial license (see repo LICENSE)",
      maintTitle: "🔧 Maintainer: one-tap reporting",
      maintDesc: "Fine-grained token (this repo only, Actions: Read and write), stored in this device's localStorage. With it, reports trigger the workflow directly instead of the form.",
      save: "Save", test: "Test", exitMaint: "Exit maintainer mode",
      saved: "Saved on this device.", clearedTok: "Cleared.", testing: "Testing…", maintOn: "🔧 Maintainer mode on",
    },
    common: { language: "Language", hm: "{h} h {m} min", m: "{m} min", dataLine: "Data: {src} · fetched {time} | engine {ver}", demoTag: " | ⚠️ DEMO mode (simulated)", loading: "Fetching Open-Meteo weather… (degrades gracefully on timeout)" },
  },

  es: {
    appTitle: "Atardeceres de Taiwán",
    sunsetWord: "Atardecer",
    nav: { forecast: "Pronóstico", log: "Reportar", settings: "Ajustes" },
    chips: { today: "Hoy", tomorrow: "Mañana", dayAfter: "+2d", plus3: "+3d" },
    weekdays: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
    banner: {
      preliminary: "📌 Pronóstico preliminar, poca confianza — el definitivo sale a las 16:20 (los modelos matutinos no ven las tormentas de la tarde)",
      stale: "⚠️ Datos en caché sin conexión (de {time}) — solo referencia",
    },
    verdict: { go: "Ve", skip: "Pasa", nodata: "Sin datos" },
    vp: { recommend: "Mejor opción: {name}", notIdealHere: "· hoy este punto no promete", notIdealRegion: "· hoy ningún punto de la región promete" },
    summary: {
      noData: "No hay datos del tiempo — solo se muestran los horarios del sol.",
      death: "Nubes bajas o lluvia lo taparán todo. Hoy no verás gran cosa.",
      idealGo: "Nubes en el punto justo: huecos abajo, combustible arriba. Vale la pena salir.",
      ideal: "Nubes en el punto justo: huecos abajo, combustible arriba.",
      tooClean: "Cielo demasiado limpio — espera un atardecer naranja normal.",
      tooThick: "Nubes medias/altas muy espesas; puede que la luz no las atraviese.",
      neutralGo: "Nubes intermedias — decide según las probabilidades.",
      neutralSkip: "Nubes intermedias, pinta floja — puedes saltarte esta noche.",
      lowCloud: "Ojo: las nubes bajas son la gran incógnita.",
      rainClear: "Que despeje tras la lluvia suma puntos.",
    },
    countdown: {
      toSunset: "<b>{h} h {m} min</b> para el atardecer",
      leaveBy: "Sal antes de las <b>{time}</b> ({mins} min de camino — llegas a la hora dorada)",
      arriveAt: "Si sales ya, llegas hacia las <b>{time}</b>",
    },
    labels: { burn: "Cielo ardiente (C+D)", visible: "Atardecer visible (B+C+D)", retry: "Reintentar", fetchFail: "Error al cargar" },
    actions: { navigate: "🧭 Cómo llegar a {name}", share: "📤 Compartir", copied: "Copiado al portapapeles" },
    share: { line1: "Veredicto {date}: {verdict} · {name}", line2: "Cielo ardiente {interval} | atardecer {time}" },
    timeline: {
      title: "Línea del sol", golden: "Dorada", effective: "Se oculta", sunset: "Atardecer", blueEnd: "Fin hora azul",
      azimuth: "Acimut del atardecer <b>{az}°</b> (aguja naranja)",
      sector: "Sector naranja = vista abierta {a}–{b}°, rojo = obstáculo registrado",
      obstruction: "Obstáculo: {note} ({deg}° de altura → el sol se oculta {mins} min antes)",
    },
    scenario: {
      title: "Cuatro escenarios",
      a: "A Tapado", b: "B Normal", c: "C Parcial", d: "D Total",
      helpTitle: "¿Qué significan A/B/C/D?",
      helpA: "<b>A Tapado</b>: nubes bajas o lluvia lo esconden todo.",
      helpB: "<b>B Normal</b>: ves ponerse el sol — naranja corriente, sin drama.",
      helpC: "<b>C Parcial</b>: parte del cielo se enciende (el umbral para salir).",
      helpD: "<b>D Total</b>: todo el cielo en llamas (pocas veces al año).",
      interval: "Las probabilidades siempre son rangos — el pronóstico es incierto y un número exacto sería falsa precisión.",
      reasonsTitle: "Por qué",
      spreadNote: "Los modelos difieren un {spread}% en nubes ({models}) → rango ampliado a ±{hw}",
      reasonsZhNote: "Detalles del análisis (en chino)",
    },
    light: {
      now: "Ahora: {name}",
      untilNext: "{next} en",
      tipsTitle: "📸 Qué hacer / fotografiar ahora",
      day: { name: "Pleno día", heading: "Aún falta para la hora dorada", next: "hora dorada",
        tips: ["Mira primero el veredicto y el radar, luego decide", "Luz plana — ideal para explorar el lugar y buscar primeros planos"] },
      golden: { name: "Hora dorada", heading: "Luz cálida y rasante en curso", next: "atardecer",
        tips: ["A favor de la luz, retratos dorados; a contraluz, siluetas y estrellas (f/11–16)", "Mide para el cielo; levanta sombras o haz horquillado ±2EV"] },
      afterglow: { name: "Ventana del resplandor", heading: "¡No te vayas! El pico de color suele llegar 10–20 min tras el atardecer", next: "fin de la hora azul",
        tips: ["Si el dorado vira a rosa → magenta, está a punto de arder — espera 5 minutos más", "La luz cae rápido: trípode o sube el ISO; balance de blancos en «Nublado» para conservar la calidez"] },
      night: { name: "Fin de la hora azul", heading: "El espectáculo de hoy terminó", next: "",
        tips: ["Mira mañana en las pestañas de fecha de arriba", "¿Acabas de fotografiarlo? Reporta A–D en «Reportar» — entrena el pronóstico"] },
    },
    checklist: {
      goTitle: "Chequeo de 60 segundos antes de salir", skipTitle: "Míralo desde casa: cámaras al oeste en vivo",
      goIntro: "El pronóstico da probabilidades; tus ojos dan el veredicto final — esto sustituye a «mirar al oeste a las 16:30».",
      skipIntro: "El veredicto es prudente, pero el cielo sorprende — echa un vistazo a las cámaras y, si se enciende, aún llegas.",
      step1: "Radar: ¿entra algún eco? (restos de tormenta)",
      step2: "Cámaras en vivo: ¿hay más nube baja al oeste de lo previsto?",
      visibility: "Visibilidad ~{km} km{warn}",
      visibilityWarn: " (baja — la calima se come los colores)",
      live: "EN VIVO", liveUnverified: "EN VIVO · enlace sin verificar", openYt: "Abrir en YouTube", unverified: " (sin verificar)",
      playAria: "Reproducir la cámara de {name}",
    },
    others: { title: "Otros puntos de la zona", nodata: "Sin datos", burnShort: "Cielo ardiente {interval}" },
    strip: { betterHint: "💡 Mañana pinta mejor (cielo ardiente {interval}) — toca «Mañana» para ver más" },
    region: { 北: "Norte", 中: "Centro", 南: "Sur", 東: "Este", 離島: "Islas" },
    locate: { btn: "📍 Cercano", ing: "Ubicando…", found: "Punto más cercano: {name} (~{km} km)",
      fail: "Ubicación fallida o denegada — elige región a mano", noGeo: "Este dispositivo no tiene geolocalización — elige región a mano" },
    onboard: {
      title: "👋 ¿Primera vez? Resumen en 30 segundos",
      b1: "«Cielo ardiente» = el atardecer incendiando las nubes. Esta app predice cada día si esta noche arde — y dónde verlo.",
      b2: "Las probabilidades siempre son rangos (p. ej. 40–60%): el pronóstico es incierto y no fingimos precisión.",
      b3: "Después, reporta lo que viste (A–D) — así el pronóstico mejora.",
      dismiss: "Entendido",
    },
    log: {
      title: "¿Cómo estuvo realmente el {date}?",
      context: "Veredicto de hoy ({name}): {verdict} · cielo ardiente {interval}",
      mine: "✅ Hoy ya reportaste <b>{outcome}</b> (toca otro para cambiarlo — solo cuenta el último)",
      oa: "Tapado, nada visible", ob: "Naranja normal", oc: "Ardió en parte", od: "Ardió todo",
      notePh: "Nota (opcional), p. ej.: ardió ~10 min al NO",
      openForm: "Formulario abierto ({outcome} ya rellenado) → pulsa Submit y el bot lo registra",
      confirm: "¿Reportar el {date} como «{outcome}»?",
      sending: "Enviando…", sent: "✅ Enviado ({outcome}) — se guarda en outcomes.csv en 1–2 min",
      sendFail: "❌ Falló (HTTP {status}) — revisa el token o usa el formulario de GitHub",
      explain: "Tu reporte alimenta el bono de «ayer ardió» y la calibración a largo plazo. Los reportes se combinan por mayoría; por persona y día solo cuenta el último (puedes cambiarlo). El envío usa un formulario de GitHub — se necesita cuenta.",
      weeklyTitle: "Esta semana",
      wPredicted: "Pronósticos {p}/7 días | reportes {r}/7 días",
      wGo: "«Ve» en {n} días: de {rep} reportados, ardió en {burn}",
      wSkip: "«Pasa» con reporte en {n} días: se perdieron {miss} noches ardientes",
      wAvg: "C+D medio previsto {v}%", wRate: "Tasa real de noches ardientes {v}%",
      wSample: "Menos de 60 días de datos: solo observación, sin ajustar reglas.", wOffline: "(⚠️ copia sin conexión, puede estar vieja)",
      histTitle: "Historial (últimos 7 días)",
      thDate: "Fecha", thVerdict: "Veredicto", thPred: "C+D prev.", thActual: "Real", thDir: "Acierto",
      dirTip: "¿Coincidió el veredicto (umbral 25) con lo que pasó?",
      notReported: "sin reporte", people: " ({n} personas)",
      dirNote: "Acierto = si el pronóstico superó el umbral (C+D≥25) coincide con si de verdad ardió. Informal — el ajuste real espera 60 días de datos.",
      empty: "Aún no hay registros. ¡Mira el atardecer de hoy y envía el primero!",
    },
    settings: {
      installTitle: "📲 Añadir a la pantalla de inicio",
      installIos: "<b>iPhone</b>: abre en Safari → Compartir → «Añadir a pantalla de inicio»",
      installAndroid: "<b>Android</b>: abre en Chrome → menú ⋮ → «Instalar aplicación»",
      installOffline: "Instalada, los horarios del sol funcionan sin conexión; el tiempo necesita internet",
      statusTitle: "Estado de los datos",
      stOpenMeteo: "Open-Meteo: {v}", stOk: "último éxito {time}", stStale: " (usando caché sin conexión)", stNone: "aún sin datos",
      stLogs: "Registros: raw.githubusercontent.com (con copia local de respaldo)",
      stMode: "Modo: {v}", stDemo: "DEMO (datos simulados)", stProd: "producción",
      stCredit: "Datos meteorológicos: <a href=\"https://open-meteo.com/\" target=\"_blank\" rel=\"noopener\">Open-Meteo</a> (CC BY 4.0)",
      stFeedback: "💬 Sugerencias (GitHub)",
      aboutTitle: "Acerca de",
      aboutText: "Motor de puntuación {ver} | reglas y lecciones en repo docs/. Geometría solar calculada en local (NOAA) — funciona sin conexión.",
      aboutPara: "El aviso de las 16:20 y las tareas de datos corren en GitHub Actions (canales y claves viven en GitHub Secrets, no aquí). Esta app sirve para consultar, reportar y repasar. Las probabilidades siempre son rangos — sin falsa precisión.",
      copyright: "© 2026 VioVenus · Licencia no comercial (ver LICENSE del repo)",
      maintTitle: "🔧 Mantenedor: reporte con un toque",
      maintDesc: "Token fine-grained (solo este repo, Actions: Read and write), guardado en el localStorage de este dispositivo. Con él, los reportes disparan el workflow directamente, sin formulario.",
      save: "Guardar", test: "Probar", exitMaint: "Salir del modo mantenedor",
      saved: "Guardado en este dispositivo.", clearedTok: "Borrado.", testing: "Probando…", maintOn: "🔧 Modo mantenedor activado",
    },
    common: { language: "Idioma", hm: "{h} h {m} min", m: "{m} min", dataLine: "Datos: {src} · obtenidos {time} | motor {ver}", demoTag: " | ⚠️ Modo DEMO (simulado)", loading: "Cargando el tiempo de Open-Meteo… (si tarda, degrada solo)" },
  },
};

function detect() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && STRINGS[saved]) return saved;
  } catch { /* ignore：node 或隱私模式 */ }
  const nav = (typeof navigator !== "undefined" && navigator.language ? navigator.language : "zh").slice(0, 2);
  return STRINGS[nav] ? nav : "zh";
}

let lang = detect();

export function getLang() {
  return lang;
}

/** 切換語言並重載（狀態都在 localStorage，重載最不易殘留半翻譯畫面）。 */
export function setLang(code) {
  if (!STRINGS[code]) return;
  try { localStorage.setItem(LANG_KEY, code); } catch { /* ignore */ }
  lang = code;
}

function lookup(dict, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

/** t("log.title", {date}) → 依目前語言取字串並插值；缺 key 退回 zh。 */
export function t(key, vars) {
  let s = lookup(STRINGS[lang], key);
  if (s === undefined) s = lookup(STRINGS.zh, key);
  if (s === undefined) return key;
  if (typeof s !== "string") return s;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`)) : s;
}

/** 靜態 HTML 翻譯：data-i18n=key → textContent；data-i18n-html → innerHTML（僅限字典內容）；
    data-i18n-ph → placeholder；data-i18n-aria → aria-label。 */
export function applyStatic(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
  document.documentElement.lang = lang === "zh" ? "zh-Hant-TW" : lang;
}

/** 供測試：三語 key 集合必須一致（防漏翻）。 */
export function _dicts() {
  return STRINGS;
}
