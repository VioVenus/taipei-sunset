"""CLI：`python -m sunset <subcommand>`。

子指令：
- analyze --date 2026-07-04 --viewpoint jiantan_laodifang：單點完整分析
  （--send 推播結果、--log 寫入預測日誌 → 供 on-demand workflow 使用）
- push-daily：每日 16:20 推播（分析全點位 → 推薦 → 推播 → 寫預測日誌）
- prompt-outcome：19:15 推播詢問今日實際結果
- weekly-review：週報（過去 7 天預測 vs 回報 + 未來展望）
- report --outcome A|B|C|D [--note ...]：寫入結果日誌
- viewpoints：列出已建檔點位
- bot：本地長輪詢 Telegram bot（/sunset /report /viewpoints）
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sunset import analysis as analysis_mod
from sunset import logbook, notify, review, telegram_io
from sunset.geometry import load_viewpoints
from sunset.solar import TAIPEI_TZ
from sunset.weather import OpenMeteoFetcher


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sunset", description="台北日落／火燒雲預測系統")
    parser.add_argument("--viewpoints-file", type=Path, default=None, help="viewpoints.json 路徑")
    parser.add_argument("--logs-dir", type=Path, default=None, help="日誌目錄（預設 data/logs）")
    sub = parser.add_subparsers(dest="command", required=True)

    p_analyze = sub.add_parser("analyze", help="單點完整分析")
    p_analyze.add_argument("--date", required=True, help="今天|明天|後天|YYYY-MM-DD")
    p_analyze.add_argument("--viewpoint", default=None, help="點位 id（預設自動推薦）")
    p_analyze.add_argument("--front", action="store_true", help="鋒面/颱風外圍 48h 內（人工 flag）")
    p_analyze.add_argument("--send", action="store_true", help="把結果推播出去（on-demand）")
    p_analyze.add_argument("--log", action="store_true", help="寫入預測日誌")

    p_push = sub.add_parser("push-daily", help="每日 16:20 推播 + 寫預測日誌")
    p_push.add_argument("--front", action="store_true", help="鋒面/颱風外圍 48h 內（人工 flag）")
    p_push.add_argument("--no-send", action="store_true", help="只印出訊息，不實際推播")

    sub.add_parser("prompt-outcome", help="19:15 推播詢問今日實際結果")

    p_weekly = sub.add_parser("weekly-review", help="週報：過去 7 天回顧 + 未來展望")
    p_weekly.add_argument("--no-send", action="store_true", help="只印出訊息，不實際推播")
    p_weekly.add_argument("--no-outlook", action="store_true", help="不打天氣 API，只出回顧")

    p_report = sub.add_parser("report", help="回報實際結果 → outcomes.csv")
    p_report.add_argument("--outcome", required=True, choices=logbook.VALID_OUTCOMES)
    p_report.add_argument("--viewpoint", default="", help="點位 id（可留空）")
    p_report.add_argument("--date", default="今天", help="結果所屬日期（預設今天）")
    p_report.add_argument("--note", default="", help="備註")

    sub.add_parser("viewpoints", help="列出已建檔點位")
    sub.add_parser("bot", help="本地長輪詢 Telegram bot")
    return parser


def _analyze_all(
    args: argparse.Namespace, target_date, front: bool
) -> list[analysis_mod.AnalysisResult]:
    viewpoints = load_viewpoints(args.viewpoints_file)
    fetcher = OpenMeteoFetcher()
    burned = logbook.burned_on(target_date - timedelta(days=1), args.logs_dir)
    return [
        analysis_mod.analyze(
            target_date, vp, fetcher, burned_yesterday=burned, front_within_48h=front
        )
        for vp in viewpoints.values()
    ]


def _log_predictions(results: list[analysis_mod.AnalysisResult], logs_dir: Path | None) -> None:
    for r in results:
        if r.probs is None:
            continue
        logbook.append_prediction(
            logbook.PredictionRecord(
                predicted_at_utc=r.generated_at_utc,
                target_date=r.target_date,
                viewpoint_id=r.viewpoint.id,
                cloud_low=r.weather.cloud_low,
                cloud_mid=r.weather.cloud_mid,
                cloud_high=r.weather.cloud_high,
                visibility=r.weather.visibility_m,
                precip_prob=r.weather.precip_prob_evening,
                rain_recent_flag=r.weather.rain_recent_flag,
                burned_yesterday_flag=False if r.probs is None else any(
                    "昨日實際有燒" in reason for reason in r.probs.reasons
                ),
                front_flag=any("鋒面" in reason for reason in r.probs.reasons),
                prob_a=r.probs.a,
                prob_b=r.probs.b,
                prob_c=r.probs.c,
                prob_d=r.probs.d,
                verdict=r.verdict,
                engine_version=r.probs.engine_version,
            ),
            logs_dir,
        )


def _send_or_note(text: str) -> int:
    """推播到所有已設定通道；沒有通道時提示，推播失敗回傳 1。"""
    if not notify.any_configured():
        print("（未設定推播通道 TELEGRAM_*/NTFY_TOPIC，僅輸出至 stdout）", file=sys.stderr)
        return 0
    sent = notify.send_push(text)
    if not sent:
        print("推播失敗（所有通道）", file=sys.stderr)
        return 1
    print(f"（已推播：{'、'.join(sent)}）", file=sys.stderr)
    return 0


def _cmd_analyze(args: argparse.Namespace) -> int:
    target_date = telegram_io.parse_date_arg(args.date)
    results = _analyze_all(args, target_date, args.front)
    if args.viewpoint:
        chosen = [r for r in results if r.viewpoint.id == args.viewpoint]
        if not chosen:
            known = ", ".join(r.viewpoint.id for r in results)
            print(f"找不到點位 {args.viewpoint!r}，已建檔點位：{known}", file=sys.stderr)
            return 1
        text = telegram_io.format_analysis(chosen[0])
    else:
        recommended = analysis_mod.recommend(results)
        if recommended is None:
            print("所有點位皆資料不足或對位警告，無法推薦。", file=sys.stderr)
            return 1
        text = telegram_io.format_daily_push(recommended, results)
    print(text)
    if args.log:
        _log_predictions(results, args.logs_dir)
    if args.send:
        return _send_or_note(text)
    return 0


def _cmd_push_daily(args: argparse.Namespace) -> int:
    today = datetime.now(TAIPEI_TZ).date()
    results = _analyze_all(args, today, args.front)
    recommended = analysis_mod.recommend(results)
    if recommended is None:
        text = f"❓ {today.isoformat()} 日落判定：資料不足（天氣 API 失敗），請以現場目視為準。"
    else:
        text = telegram_io.format_daily_push(recommended, results)
    print(text)
    _log_predictions(results, args.logs_dir)
    if not args.no_send:
        return _send_or_note(text)
    return 0


def _cmd_prompt_outcome(args: argparse.Namespace) -> int:
    today = datetime.now(TAIPEI_TZ).date()
    text = telegram_io.format_outcome_prompt(today)
    print(text)
    return _send_or_note(text)


def _cmd_weekly_review(args: argparse.Namespace) -> int:
    today = datetime.now(TAIPEI_TZ).date()
    stats = review.build_weekly_stats(today, args.logs_dir)
    outlooks: list[analysis_mod.AnalysisResult] = []
    if not args.no_outlook:
        for offset in (1, 2):
            results = _analyze_all(args, today + timedelta(days=offset), front=False)
            best = analysis_mod.recommend(results)
            if best is not None:
                outlooks.append(best)
    text = review.format_weekly_review(stats, tuple(outlooks))
    print(text)
    if not args.no_send:
        return _send_or_note(text)
    return 0


def _cmd_report(args: argparse.Namespace) -> int:
    target_date = telegram_io.parse_date_arg(args.date)
    path = logbook.append_outcome(
        logbook.OutcomeRecord(
            target_date=target_date,
            reported_at_utc=datetime.now(UTC),
            outcome=args.outcome,
            viewpoint_id=args.viewpoint,
            note=args.note,
        ),
        args.logs_dir,
    )
    print(f"已記錄 {target_date.isoformat()} 結果 {args.outcome} → {path}")
    return 0


def _cmd_viewpoints(args: argparse.Namespace) -> int:
    for vp in load_viewpoints(args.viewpoints_file).values():
        lo, hi = vp.open_azimuth_range
        print(f"{vp.id}｜{vp.name}｜開闊方位 {lo:.0f}–{hi:.0f}°｜{vp.access}")
    return 0


def _cmd_bot(args: argparse.Namespace) -> int:  # pragma: no cover - 需長連線
    client = telegram_io.TelegramClient()
    if not client.configured:
        print("請先設定 TELEGRAM_BOT_TOKEN 與 TELEGRAM_CHAT_ID 環境變數", file=sys.stderr)
        return 1

    def handle(text: str, chat_id: str) -> str | None:
        parts = text.split()
        cmd = parts[0].split("@")[0].lower()
        try:
            if cmd == "/sunset":
                target_date = telegram_io.parse_date_arg(parts[1] if len(parts) > 1 else "今天")
                results = _analyze_all(args, target_date, front=False)
                if len(parts) > 2:
                    chosen = [r for r in results if r.viewpoint.id == parts[2]]
                    if not chosen:
                        return f"找不到點位 {parts[2]}，用 /viewpoints 查看已建檔點位"
                    return telegram_io.format_analysis(chosen[0])
                recommended = analysis_mod.recommend(results)
                if recommended is None:
                    return "所有點位皆資料不足，請稍後重試。"
                return telegram_io.format_daily_push(recommended, results)
            if cmd == "/report":
                if len(parts) < 2 or parts[1].upper() not in logbook.VALID_OUTCOMES:
                    return "用法：/report A|B|C|D [備註]"
                note = " ".join(parts[2:])
                today = datetime.now(TAIPEI_TZ).date()
                logbook.append_outcome(
                    logbook.OutcomeRecord(
                        target_date=today,
                        reported_at_utc=datetime.now(UTC),
                        outcome=parts[1].upper(),
                        viewpoint_id="",
                        note=note,
                    ),
                    args.logs_dir,
                )
                return f"✅ 已記錄 {today.isoformat()} 結果 {parts[1].upper()}（將用於明日持續性加成）"
            if cmd == "/viewpoints":
                vps = load_viewpoints(args.viewpoints_file).values()
                return "\n".join(f"{vp.id}｜{vp.name}｜{vp.access}" for vp in vps)
        except ValueError as exc:
            return str(exc)
        return None

    print("bot 已啟動（長輪詢），Ctrl-C 結束")
    telegram_io.run_bot(handle, client)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    handlers = {
        "analyze": _cmd_analyze,
        "push-daily": _cmd_push_daily,
        "prompt-outcome": _cmd_prompt_outcome,
        "weekly-review": _cmd_weekly_review,
        "report": _cmd_report,
        "viewpoints": _cmd_viewpoints,
        "bot": _cmd_bot,
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
