#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dao-evolution search CLI — BM25 search over project evolution records.

Usage:
  python search.py search "query"           Search entries + lessons
  python search.py entries "query"          Search entries only
  python search.py lessons "query"          Search lessons only
  python search.py stats                    Show summary statistics
  python search.py ensure                   Initialize CSV or migrate legacy records
  python search.py init                     Initialize CSV files for current project
  python search.py stale [--threshold N]    Flag stale lessons for review

Options:
  --data-dir DIR       Data directory (default: CWD/data)
  --max-results N      Max results per category (default: 5)
  --include-deprecated Include deprecated lessons in search
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from core import (
    init_data, search_all, search_entries, search_lessons,
    stats, flag_stale_lessons
)


def format_entry(e):
    status_icon = {"draft": "📝", "mature": "📗", "synthesized": "🔗"}.get(e.get("status"), "❓")
    return (
        f"  {status_icon} [{e['id']}] {e.get('title', '')}\n"
        f"     {e.get('date', '')} | {e.get('version', '')} | {e.get('component', '')}\n"
        f"     root_cause: {e.get('root_cause', '')}\n"
        f"     tags: {e.get('tags', '')} | score: {e.get('_score', '')}"
    )


def format_lesson(l):
    status_icon = {"active": "✅", "deprecated": "⛔", "review": "⚠️"}.get(l.get("status"), "❓")
    sup = f" → {l['superseded_by']}" if l.get("superseded_by") else ""
    return (
        f"  {status_icon} [{l['id']}] {l.get('title', '')}{sup}\n"
        f"     {l.get('version', '')} | {l.get('component', '')}\n"
        f"     {l.get('detail', '')[:120]}{'...' if len(l.get('detail', '')) > 120 else ''}\n"
        f"     tags: {l.get('tags', '')} | score: {l.get('_score', '')}"
    )


def cmd_search(args):
    result = search_all(args.data_dir, args.query, args.max_results)

    if not result["entries"] and not result["lessons"]:
        print(f"No results for: {args.query}")
        return

    if result["entries"]:
        print(f"\n== Entries ({len(result['entries'])}) ==")
        for e in result["entries"]:
            print(format_entry(e))

    if result["lessons"]:
        print(f"\n== Lessons ({len(result['lessons'])}) ==")
        for l in result["lessons"]:
            print(format_lesson(l))


def cmd_entries(args):
    status_filter = None
    if hasattr(args, "status") and args.status:
        status_filter = [args.status]
    results = search_entries(args.data_dir, args.query, args.max_results, status_filter)
    if not results:
        print(f"No entries for: {args.query}")
        return
    print(f"\n== Entries ({len(results)}) ==")
    for e in results:
        print(format_entry(e))


def cmd_lessons(args):
    status_filter = None
    if args.include_deprecated:
        status_filter = ["active", "deprecated", "review"]
    results = search_lessons(args.data_dir, args.query, args.max_results, status_filter)
    if not results:
        print(f"No lessons for: {args.query}")
        return
    print(f"\n== Lessons ({len(results)}) ==")
    for l in results:
        print(format_lesson(l))


def cmd_stats(args):
    s = stats(args.data_dir)
    eb = s["entries_by_status"]
    lb = s["lessons_by_status"]
    print(
        f"Entries: {s['entries_total']} "
        f"(draft:{eb.get('draft',0)} mature:{eb.get('mature',0)} synthesized:{eb.get('synthesized',0)})\n"
        f"Lessons: {s['lessons_total']} "
        f"(active:{lb.get('active',0)} deprecated:{lb.get('deprecated',0)} review:{lb.get('review',0)})\n"
        f"Latest entry: {s['latest_entry_date']}"
    )


def cmd_init(args):
    created = init_data(args.data_dir)
    if created:
        print(f"Created: {', '.join(created)} in {args.data_dir}")
    else:
        print(f"Already initialized: {args.data_dir}")


def cmd_ensure(args):
    data_dir = Path(args.data_dir)
    project_root = data_dir.parent
    entries_path = data_dir / "evolution-entries.csv"
    lessons_path = data_dir / "evolution-lessons.csv"

    if entries_path.exists() and lessons_path.exists():
        print(f"Already initialized: {data_dir}")
        return

    guide_path = project_root / "AGENT_GUIDE.md"
    evolution_path = project_root / "docs" / "evolution.md"
    has_legacy_sources = guide_path.exists() or evolution_path.exists()

    if has_legacy_sources:
        migrate_script = Path(__file__).with_name("migrate.py")
        result = subprocess.run(
            [sys.executable, str(migrate_script), str(project_root)],
            check=False,
        )
        if result.returncode != 0:
            raise SystemExit(result.returncode)
        return

    created = init_data(data_dir)
    if created:
        print(f"Created: {', '.join(created)} in {data_dir}")
    else:
        print(f"Already initialized: {data_dir}")


def cmd_stale(args):
    flagged = flag_stale_lessons(args.data_dir, args.threshold)
    if flagged:
        print(f"Flagged {len(flagged)} lessons for review: {', '.join(flagged)}")
    else:
        print("No stale lessons found.")


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--data-dir", default=str(Path.cwd() / "data"),
                        help="Data directory (default: CWD/data)")
    common.add_argument("--max-results", type=int, default=5)

    parser = argparse.ArgumentParser(
        description="dao-evolution: BM25 search over evolution records",
        parents=[common],
    )

    sub = parser.add_subparsers(dest="command")

    p_search = sub.add_parser("search", help="Search entries + lessons", parents=[common])
    p_search.add_argument("query")

    p_entries = sub.add_parser("entries", help="Search entries only", parents=[common])
    p_entries.add_argument("query")
    p_entries.add_argument("--status", choices=["draft", "mature", "synthesized"])

    p_lessons = sub.add_parser("lessons", help="Search lessons only", parents=[common])
    p_lessons.add_argument("query")
    p_lessons.add_argument("--include-deprecated", action="store_true")

    sub.add_parser("stats", help="Summary statistics", parents=[common])
    sub.add_parser("ensure", help="Initialize CSV files or migrate legacy sources", parents=[common])
    sub.add_parser("init", help="Initialize CSV files", parents=[common])

    p_stale = sub.add_parser("stale", help="Flag stale lessons for review", parents=[common])
    p_stale.add_argument("--threshold", type=int, default=5,
                         help="Major versions behind to flag (default: 5)")

    args = parser.parse_args()

    if args.command == "search":
        cmd_search(args)
    elif args.command == "entries":
        cmd_entries(args)
    elif args.command == "lessons":
        cmd_lessons(args)
    elif args.command == "stats":
        cmd_stats(args)
    elif args.command == "ensure":
        cmd_ensure(args)
    elif args.command == "init":
        cmd_init(args)
    elif args.command == "stale":
        cmd_stale(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
