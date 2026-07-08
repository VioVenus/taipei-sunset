"""Telegram 推播與訊息格式化（繁體中文、區間機率、理由條列）。

直接以 requests 打 Telegram HTTP API（比 python-telegram-bot 更少依賴）。
Secrets 走環境變數 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，絕不落地 repo。
"""

from __future__ import annotations

import os
import time as time_mod
from datetime import date, datetime, timedelta
from typing import Any

import requests

from sunset.analysis import VERDICT_GO, VERDICT_NO_DATA, AnalysisResult
from sunset.scoring import prob_interval
from sunset.solar import TAIPEI_TZ

TELEGRAM_API_BASE = "https://api.telegram.org"
REQUEST_TIMEOUT_SEC = 10.0
RETRY_COUNT = 1

WEEKDAY_ZH = ("一", "二", "三", "四", "五", "六", "日")
# 查詢範圍：今天～未來 3 天
MAX_QUERY_DAYS_AHEAD = 3

PRELIMINARY_NOTE = "📌 初步展望，信心低，以當日 16:20 推播為準（早上的預報對午後對流幾乎無鑑別力）"


def _date_label(d: date) -> str:
    return f"{d.month}/{d.day}（{WEEKDAY_ZH[d.weekday()]}）"


CWA_RADAR_URL = "https://www.cwa.gov.tw/V8/C/W/OBS_Radar.html"


def _interval_str(point: float, half_width: float | None = None) -> str:
    lo, hi = prob_interval(point, half_width)
    return f"{lo}–{hi}%"


def _hhmm(dt: datetime) -> str:
    return dt.astimezone(TAIPEI_TZ).strftime("%H:%M")


def format_analysis(result: AnalysisResult) -> str:
    """單點完整分析（/sunset 指令與 CLI 輸出）。"""
    lines: list[str] = []
    if result.verdict == VERDICT_GO:
        header_icon = "🌇"
    elif result.verdict == VERDICT_NO_DATA:
        header_icon = "❓"
    else:
        header_icon = "🌆"
    lines.append(
        f"{header_icon} {_date_label(result.target_date)} 日落判定：{result.verdict}・{result.viewpoint.name}"
    )
    sun = result.sun
    lines.append(
        f"日落 {_hhmm(sun.sunset_local)}｜方位 {sun.sunset_azimuth_deg:.1f}°｜"
        f"黃金時段 {_hhmm(sun.golden_start_local)} 起｜藍調至 {_hhmm(sun.civil_twilight_end_local)}"
    )
    if result.obstruction.matched:
        lines.append(
            f"遮蔽：{result.obstruction.note}（仰角 {result.obstruction.angle_deg:.1f}° → "
            f"太陽約 {_hhmm(result.effective_sunset_local)} 提前沒入，"
            f"提前 {result.obstruction.early_minutes:.0f} 分鐘）"
        )
    lines.append(result.alignment.message)

    if result.probs is None:
        lines.append(f"⚠️ 資料不足：{result.weather.error or '天氣資料取得失敗'}")
        lines.append("暫無法評分，請稍後重試或以現場目視為準。")
    else:
        p = result.probs
        hw = result.interval_half_width
        lines.append(
            f"看得到日落：{_interval_str(p.sunset_visible, hw)}｜"
            f"火燒雲：{_interval_str(p.burn_level, hw)}"
        )
        lines.append(
            f"情境：A擋光 {p.a:.0f}% / B普通 {p.b:.0f}% / C局部燒 {p.c:.0f}% / D全面燒 {p.d:.0f}%"
        )
        lines.append("理由：")
        lines.extend(f"・{reason}" for reason in p.reasons)
        if hw > 10.0 and result.weather.model_spread is not None:
            lines.append(
                f"・多模式雲量分歧 {result.weather.model_spread:.0f}%"
                f"（{result.weather.ensemble_models}）→ 區間加寬至 ±{hw:.0f}"
            )
    cc = result.cross_check
    if cc is not None and cc.ok:
        line = f"CWA 交叉驗證（臺北市 {cc.period_label}）：{cc.wx_text}，降雨機率 {cc.pop_percent:.0f}%"
        om_pop = result.weather.precip_prob_evening
        if om_pop is not None and abs(cc.pop_percent - om_pop) > 30.0:
            line += f"\n⚠️ 與 Open-Meteo（{om_pop:.0f}%）分歧大，今晚不確定性高"
        lines.append(line)
    if result.viewpoint.weather_exclusion:
        lines.append(f"⚠️ {result.viewpoint.weather_exclusion}")
    if result.preliminary:
        lines.append(PRELIMINARY_NOTE)
    return "\n".join(lines)


def format_daily_push(recommended: AnalysisResult, all_results: list[AnalysisResult]) -> str:
    """每日 16:20 推播訊息（含推薦點位）。"""
    text = format_analysis(recommended)
    others = [r for r in all_results if r.viewpoint.id != recommended.viewpoint.id and r.probs]
    if others:
        extra = "、".join(
            f"{r.viewpoint.name} 火燒雲 {_interval_str(r.probs.burn_level, r.interval_half_width)}"  # type: ignore[union-attr]
            for r in others
        )
        text += f"\n其他點位：{extra}"
    blue_hour = _hhmm(recommended.sun.civil_twilight_end_local - timedelta(minutes=9))
    text += f"\n⚠️ 對流殘留請開雷達確認後再上山；看到 {blue_hour} 再走"
    text += f"\n🌩 雷達回波：{CWA_RADAR_URL}"
    return text


def format_outcome_prompt(target_date: date) -> str:
    """19:15 推播：詢問今日實際結果。"""
    return (
        f"📝 {_date_label(target_date)} 今晚實際結果是哪一種？\n"
        "回覆 /report A|B|C|D [備註]\n"
        "A 全擋沒看到 / B 普通橘色 / C 局部火燒雲 / D 全面火燒雲\n"
        "（你的回報會寫入結果日誌，供明日持續性加成與後續校準使用）"
    )


class TelegramClient:
    """極簡 Telegram Bot API 客戶端（sendMessage / getUpdates）。"""

    def __init__(
        self,
        token: str | None = None,
        chat_id: str | None = None,
        session: Any | None = None,
    ) -> None:
        self.token = token or os.environ.get("TELEGRAM_BOT_TOKEN", "")
        self.chat_id = chat_id or os.environ.get("TELEGRAM_CHAT_ID", "")
        self._session = session if session is not None else requests

    @property
    def configured(self) -> bool:
        return bool(self.token and self.chat_id)

    def _call(self, method: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        url = f"{TELEGRAM_API_BASE}/bot{self.token}/{method}"
        for attempt in range(RETRY_COUNT + 1):
            try:
                resp = self._session.post(url, json=payload, timeout=REQUEST_TIMEOUT_SEC)
                resp.raise_for_status()
                return resp.json()
            except Exception:  # noqa: BLE001 - 降級路徑
                if attempt < RETRY_COUNT:
                    time_mod.sleep(1.0)
        return None

    def send_message(self, text: str, chat_id: str | None = None) -> bool:
        """推播訊息；失敗回傳 False（呼叫端決定降級行為），不拋例外。"""
        result = self._call(
            "sendMessage", {"chat_id": chat_id or self.chat_id, "text": text}
        )
        return bool(result and result.get("ok"))

    def get_updates(self, offset: int | None = None, timeout_sec: int = 25) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {"timeout": timeout_sec}
        if offset is not None:
            payload["offset"] = offset
        result = self._call("getUpdates", payload)
        if not result or not result.get("ok"):
            return []
        return result.get("result", [])


def parse_date_arg(arg: str, today: date | None = None) -> date:
    """解析 今天|明天|後天|YYYY-MM-DD，限制在今天～未來 3 天。"""
    base = today or datetime.now(TAIPEI_TZ).date()
    aliases = {"今天": 0, "明天": 1, "後天": 2, "today": 0, "tomorrow": 1}
    if arg in aliases:
        target = base + timedelta(days=aliases[arg])
    else:
        target = date.fromisoformat(arg)
    offset = (target - base).days
    if not 0 <= offset <= MAX_QUERY_DAYS_AHEAD:
        raise ValueError(f"日期需在今天～未來 {MAX_QUERY_DAYS_AHEAD} 天內（收到 {target.isoformat()}）")
    return target


def run_bot(handle_command, client: TelegramClient) -> None:  # pragma: no cover - 需長連線
    """本地長輪詢 bot（Phase 0 供本機執行；Actions 環境用排程推播）。

    handle_command(text: str, chat_id: str) -> str | None：回傳要回覆的文字。
    """
    offset: int | None = None
    while True:
        for update in client.get_updates(offset=offset):
            offset = update["update_id"] + 1
            message = update.get("message") or {}
            text = (message.get("text") or "").strip()
            chat_id = str((message.get("chat") or {}).get("id", ""))
            if not text or not chat_id:
                continue
            reply = handle_command(text, chat_id)
            if reply:
                client.send_message(reply, chat_id=chat_id)
