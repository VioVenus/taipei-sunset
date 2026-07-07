"""ingest.py 測試：Issue Form 解析、驗證、共識聚合。"""

from datetime import UTC, date, datetime
from pathlib import Path

from sunset import ingest, logbook

NOW = datetime(2026, 7, 4, 11, 30, tzinfo=UTC)  # 台北 7/4 19:30


def _body(
    outcome="C 局部火燒雲", d="今天", vp="jiantan_laodifang（劍潭山老地方）", note="西北側有燒"
):
    return f"""### 今晚實際結果

{outcome}

### 日期

{d}

### 點位

{vp}

### 備註

{note}
"""


def test_ingest_valid_report(tmp_path: Path):
    result = ingest.ingest(_body(), "alice", "issue#12", tmp_path, now_utc=NOW)
    assert result.ok, result.message
    rows = logbook.read_reports(tmp_path)
    assert len(rows) == 1
    assert rows[0]["outcome"] == "C"
    assert rows[0]["target_date"] == "2026-07-04"
    assert rows[0]["viewpoint_id"] == "jiantan_laodifang"
    assert rows[0]["reporter"] == "alice"
    assert rows[0]["source"] == "issue#12"


def test_ingest_yesterday_and_iso_date(tmp_path: Path):
    assert ingest.ingest(_body(d="昨天"), "a", "issue#1", tmp_path, now_utc=NOW).ok
    assert logbook.read_reports(tmp_path)[0]["target_date"] == "2026-07-03"
    assert ingest.ingest(_body(d="2026-07-04"), "a", "issue#2", tmp_path, now_utc=NOW).ok


def test_ingest_rejects_bad_outcome_and_old_date(tmp_path: Path):
    bad = ingest.ingest(_body(outcome="超級燒"), "a", "issue#1", tmp_path, now_utc=NOW)
    assert not bad.ok and "無法辨識" in bad.message
    old = ingest.ingest(_body(d="2026-06-20"), "a", "issue#2", tmp_path, now_utc=NOW)
    assert not old.ok and "日期無效" in old.message
    future = ingest.ingest(_body(d="2026-07-09"), "a", "issue#3", tmp_path, now_utc=NOW)
    assert not future.ok
    assert logbook.read_reports(tmp_path) == []  # 被拒的不落檔


def test_ingest_unknown_viewpoint_still_accepted(tmp_path: Path):
    result = ingest.ingest(_body(vp="其他／不確定"), "a", "issue#1", tmp_path, now_utc=NOW)
    assert result.ok
    assert logbook.read_reports(tmp_path)[0]["viewpoint_id"] == ""


def test_ingest_sanitizes_note(tmp_path: Path):
    result = ingest.ingest(
        _body(note="第一行\n第二行\t很長" + "x" * 300), "a", "issue#1", tmp_path, now_utc=NOW
    )
    assert result.ok
    note = logbook.read_reports(tmp_path)[0]["note"]
    assert "\n" not in note and len(note) <= ingest.NOTE_MAX_LEN


def test_ingest_no_response_placeholder(tmp_path: Path):
    body = _body(note="_No response_", vp="_No response_")
    result = ingest.ingest(body, "a", "issue#1", tmp_path, now_utc=NOW)
    assert result.ok
    row = logbook.read_reports(tmp_path)[0]
    assert row["note"] == "" and row["viewpoint_id"] == ""


def test_consensus_majority_and_tie(tmp_path: Path):
    d = date(2026, 7, 4)
    for reporter, outcome in (("a", "C"), ("b", "D"), ("c", "B")):
        ingest.ingest(_body(outcome=outcome), reporter, "issue", tmp_path, now_utc=NOW)
    # 燒 2 票（C,D）> 非燒 1 票（B）→ 有燒
    assert logbook.burned_on(d, tmp_path)
    # 眾數平手（C=D=B=1）→ 取較保守 B
    assert logbook.consensus_outcome(d, tmp_path) == "B"


def test_consensus_latest_per_reporter(tmp_path: Path):
    d = date(2026, 7, 4)
    early = datetime(2026, 7, 4, 11, 0, tzinfo=UTC)
    ingest.ingest(_body(outcome="D"), "a", "issue#1", tmp_path, now_utc=early)
    ingest.ingest(_body(outcome="A"), "a", "issue#2", tmp_path, now_utc=NOW)  # 改口
    assert not logbook.burned_on(d, tmp_path)  # 只採計最新一票 A
    assert logbook.consensus_outcome(d, tmp_path) == "A"


def test_consensus_merges_owner_outcomes(tmp_path: Path):
    """outcomes.csv（owner 管道）與 reports.csv 同池聚合。"""
    d = date(2026, 7, 4)
    logbook.append_outcome(
        logbook.OutcomeRecord(
            target_date=d, reported_at_utc=NOW, outcome="D", viewpoint_id=""
        ),
        tmp_path,
    )
    ingest.ingest(_body(outcome="C"), "bob", "issue#5", tmp_path, now_utc=NOW)
    assert logbook.burned_on(d, tmp_path)  # 2 燒 : 0 非燒
    votes = logbook.all_reports(tmp_path)
    assert {v.get("reporter") for v in votes} == {"owner", "bob"}
