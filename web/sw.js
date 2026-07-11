// Service Worker：app shell cache-first；天氣/日誌 API 一律 network-only
// （過期預報比沒有預報危險——降級邏輯在 app 層用 localStorage 處理並明確標 stale）。
const CACHE = "sunset-shell-v8";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "js/app.js",
  "js/config.js",
  "js/solar.js",
  "js/geometry.js",
  "js/scoring.js",
  "js/weather.js",
  "js/analysis.js",
  "js/format.js",
  "js/light.js",
  "js/i18n.js",
  "js/logs.js",
  "js/github.js",
  "data/viewpoints.json",
  "data/cams.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const external = url.origin !== location.origin;
  if (external || e.request.method !== "GET") return; // 天氣/GitHub API：network-only
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request)),
  );
});
