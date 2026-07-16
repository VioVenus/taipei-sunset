// 部署設定（遷移到新 repo 時只改這一檔）。
export const REPO = "VioVenus/taipei-sunset";
export const BRANCH = "main";

// 群眾回報中繼（Cloudflare Worker）。兩者皆為公開值（非機密）。
// 兩個都填了才會啟用「免 GitHub 帳號、免跳轉」的 app 內回報；
// 留空 → 自動退回預填 Issue Form 流程（現況），不會壞。部署見 docs/report-relay.md。
export const RELAY_URL = ""; // 例 https://taipei-sunset-report-relay.<你的子域>.workers.dev
export const TURNSTILE_SITEKEY = ""; // Cloudflare Turnstile 網站金鑰（0x4AAA…）
