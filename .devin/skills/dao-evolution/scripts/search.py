#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dao-evolution search CLI — BM25 search over project evolution records.

Usage:
  python search.py search "query"           Search entries + lessons
  python search.py entries "query"          Search entries only
  python search.py lessons "query"          Search lessons only
  python search.py stats                    Show summary statistics
  python search.py init                     Initialize CSV files for current project

Options:
  --data-dir DIR       Data directory (default: CWD/data)
  --max-results N      Max results per category (default: 5)
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from core import init_data, search_all, search_entries, search_lessons, stats


def format_entry(e):
    summary = e.get('summary', '')
    truncated = f"{summary[:120]}..." if len(summary) > 120 else summary
    return (
        f"  [{e['id']}] {e.get('title', '')}\n"
        f"     {e.get('date', '')} | {truncated}\n"
        f"     tags: {e.get('tags', '')} | score: {e.get('_score', '')}"
    )


def format_lesson(l):
    insight = l.get('insight', '')
    truncated = f"{insight[:120]}..." if len(insight) > 120 else insight
    return (
        f"  [{l['id']}] {l.get('title', '')}\n"
        f"     {l.get('date', '')}\n"
        f"     {truncated}\n"
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
    results = search_entries(args.data_dir, args.query, args.max_results)
    if not results:
        print(f"No entries for: {args.query}")
        return
    print(f"\n== Entries ({len(results)}) ==")
    for e in results:
        print(format_entry(e))


def cmd_lessons(args):
    results = search_lessons(args.data_dir, args.query, args.max_results)
    if not results:
        print(f"No lessons for: {args.query}")
        return
    print(f"\n== Lessons ({len(results)}) ==")
    for l in results:
        print(format_lesson(l))


def cmd_stats(args):
    s = stats(args.data_dir)
    print(
        f"Entries: {s['entries_total']}\n"
        f"Lessons: {s['lessons_total']}\n"
        f"Latest entry: {s['latest_entry_date']}"
    )


def cmd_init(args):
    created = init_data(args.data_dir)
    if created:
        print(f"Created: {', '.join(created)} in {args.data_dir}")
    else:
        print(f"Already initialized: {args.data_dir}")


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

    p_lessons = sub.add_parser("lessons", help="Search lessons only", parents=[common])
    p_lessons.add_argument("query")

    sub.add_parser("stats", help="Summary statistics", parents=[common])
    sub.add_parser("init", help="Initialize CSV files", parents=[common])

    args = parser.parse_args()

    if args.command == "search":
        cmd_search(args)
    elif args.command == "entries":
        cmd_entries(args)
    elif args.command == "lessons":
        cmd_lessons(args)
    elif args.command == "stats":
        cmd_stats(args)
    elif args.command == "init":
        cmd_init(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
