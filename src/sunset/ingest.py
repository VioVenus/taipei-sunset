"""群眾回報 ingest：解析 GitHub Issue Form → 驗證 → reports.csv。

公開版回報管線：任何 GitHub 使用者透過 Issue Form 回報今晚實際結果，
Actions 觸發本模組解析與落檔（append-only），再自動回覆並關閉 issue。
驗證原則：寧可拒收也不落髒資料；被拒的回報會在 issue 得到明確原因。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from sunset import logbook
from sunset.geometry import load_viewpoints

TAIPEI_TZ = ZoneInfo("Asia/Taipei")

# 只接受「今天」與「昨天」的回報（跨午夜補報）；更久遠的回憶不可靠，不收
MAX_REPORT_AGE_DAYS = 1
NOTE_MAX_LEN = 200
_NO_RESPONSE = "_no response_"


@dataclass(frozen=True)
class IngestResult:
    ok: bool
    message: str  # 貼回 issue 的說明（繁中）
    record: logbook.ReportRecord | None = None


def parse_issue_form(body: str) -> dict[str, str]:
    """Issue Form 產出的 markdown（### 標題 + 內容）→ {標題: 首行內容}。"""
    fields: dict[str, str] = {}
    current: str | None = None
    for line in body.splitlines():
        heading = re.match(r"^###\s+(.+?)\s*$", line)
        if heading:
            current = heading.group(1)
            fields[current] = ""
        elif current and not fields[current]:
            text = line.strip()
            if text and text.lower() != _NO_RESPONSE:
                fields[current] = text
    return fields


def _parse_target_date(raw: str, today: date) -> date | None:
    text = raw.strip()
    if text in ("今天", "today", ""):
        return today
    if text in ("昨天", "yesterday"):
        return today - timedelta(days=1)
    try:
        parsed = date.fromisoformat(text[:10])
    except ValueError:
        return None
    if 0 <= (today - parsed).days <= MAX_REPORT_AGE_DAYS:
        return parsed
    return None


def _sanitize_note(raw: str) -> str:
    # 單行、去控制字元、截長度——note 會進 CSV 與公開頁面
    text = re.sub(r"[\r\n\t]+", " ", raw).strip()
    return text[:NOTE_MAX_LEN]


def ingest(
    body: str,
    reporter: str,
    source: str,
    logs_dir: Path | None = None,
    now_utc: datetime | None = None,
) -> IngestResult:
    """解析並落檔一筆回報；失敗回傳 ok=False 與原因（不拋例外）。"""
    now = now_utc or datetime.now(UTC)
    today = now.astimezone(TAIPEI_TZ).date()
    fields = parse_issue_form(body)

    def field(*names: str) -> str:
        for name in names:
            for key, value in fields.items():
                if name in key:
                    return value
        return ""

    outcome_raw = field("實際結果", "結果", "outcome").strip().upper()
    outcome = outcome_raw[:1]
    if outcome not in logbook.VALID_OUTCOMES:
        return IngestResult(
            ok=False,
            message=f"❌ 無法辨識結果「{outcome_raw or '（空白）'}」，需為 A／B／C／D 開頭。",
        )

    target = _parse_target_date(field("日期", "date"), today)
    if target is None:
        return IngestResult(
            ok=False,
            message=(
                f"❌ 日期無效或超出範圍：只接受「今天」「昨天」或 {MAX_REPORT_AGE_DAYS + 1} 天內的"
                " YYYY-MM-DD（隔太久的回憶不進校準資料）。"
            ),
        )

    viewpoint_raw = field("點位", "viewpoint")
    viewpoint_id = ""
    if viewpoint_raw:
        token = re.split(r"[（(\s｜|]", viewpoint_raw.strip())[0]
        known = load_viewpoints()
        if token in known:
            viewpoint_id = token
        # 不在建檔清單（例如「其他／不確定」）→ 留空，仍收單（回報比點位精確更重要）

    # 日輪可見度（教訓 6，選填）：與 A–D 脫鉤的另一軸，先以 note 標記存下（不併入共識）
    sun_raw = field("太陽本身", "太陽", "sun disk", "sun")
    sun_tag = ""
    if "擋" in sun_raw or "blocked" in sun_raw.lower() or "tapado" in sun_raw.lower():
        sun_tag = "[太陽被擋] "
    elif "看得到" in sun_raw or "visible" in sun_raw.lower():
        sun_tag = "[有看到太陽] "

    record = logbook.ReportRecord(
        target_date=target,
        reported_at_utc=now,
        outcome=outcome,
        viewpoint_id=viewpoint_id,
        note=_sanitize_note(sun_tag + field("備註", "note")),
        reporter=reporter or "anonymous",
        source=source,
    )
    logbook.append_report(record, logs_dir)
    consensus = logbook.consensus_outcome(target, logs_dir)
    return IngestResult(
        ok=True,
        message=(
            f"✅ 已記錄 {target.isoformat()} 結果 **{outcome}**（回報者 @{record.reporter}）。\n"
            f"目前該日共識：**{consensus}**。你的回報會用於隔日持續性加成與後續校準，感謝！\n"
            f"（同一人同一天多次回報只採計最新一筆）"
        ),
        record=record,
    )
