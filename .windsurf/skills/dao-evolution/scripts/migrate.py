#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
migrate.py — Migrate AGENT_GUIDE.md tables to evolution CSV files.

Usage:
  python migrate.py <AGENT_GUIDE.md path> <output data dir>

Example:
  python migrate.py "d:/frank/道/无感切号/AGENT_GUIDE.md" "d:/frank/道/无感切号/data"

Parses:
  §二 演化索引 → evolution-entries.csv
  §三 教训清单 → evolution-lessons.csv
"""

import csv
import re
import sys
from pathlib import Path
from datetime import date

sys.path.insert(0, str(Path(__file__).parent))
from core import ENTRIES_HEADERS, LESSONS_HEADERS, init_data


def parse_markdown_table(lines):
    """Parse a markdown table into list of row-lists. Handles multi-cell content."""
    rows = []
    for line in lines:
        line = line.strip()
        if not line.startswith('|'):
            continue
        if re.match(r'^\|[\s\-:]+\|', line):
            continue
        cells = [c.strip() for c in line.split('|')[1:-1]]
        if cells:
            rows.append(cells)
    return rows


def extract_title_from_change(text):
    """Extract bold title from 核心变更 cell."""
    m = re.search(r'\*\*(.+?)\*\*', text)
    if m:
        title = m.group(1)
        title = re.sub(r'^[A-Z]\d+[:\s]*', '', title)
        return title[:200]
    return text[:100]


def extract_tags(text):
    """Extract likely tags from text content."""
    tag_patterns = [
        r'heartbeat', r'心跳', r'切号', r'switch', r'续传', r'retry',
        r'S0', r'webview', r'Firebase', r'auth', r'认证',
        r'quota', r'配额', r'限流', r'rate.?limit',
        r'vscdb', r'state\.vscdb', r'inject', r'hotSwitch',
        r'protobuf', r'gRPC', r'API', r'DOM', r'CSP',
        r'云端', r'cloud', r'patch', r'timer', r'suspend',
        r'WAM', r'leaderboard', r'consumption', r'消耗',
    ]
    found = set()
    text_lower = text.lower()
    for p in tag_patterns:
        if re.search(p, text, re.IGNORECASE):
            found.add(p.replace(r'.?', '').replace(r'\.', '.').lower())
    return ';'.join(sorted(found))


def detect_superseded(detail):
    """Check if a lesson mentions being superseded."""
    patterns = [
        r'已被\s*(T\d+)\s*推翻',
        r'已过时.*?→\s*(T\d+)',
        r'~~.*~~.*→\s*(T\d+)',
        r'修正.*详见\s*(T\d+)',
    ]
    for p in patterns:
        m = re.search(p, detail)
        if m:
            return m.group(1)
    if '已过时' in detail or '~~' in detail or '已被' in detail:
        return 'check_manually'
    return ''


def parse_entries_section(content):
    """Parse §二 演化索引 into entry dicts."""
    m = re.search(r'## 二、演化索引(.*?)(?=## [三四五六七八九]|\Z)', content, re.DOTALL)
    if not m:
        print("WARNING: §二 演化索引 not found")
        return []

    section = m.group(1)
    lines = section.strip().split('\n')
    rows = parse_markdown_table(lines)

    if not rows:
        print("WARNING: No table rows found in §二")
        return []

    header = rows[0]
    print(f"  §二 header: {header}")

    entries = []
    for i, row in enumerate(rows[1:] if len(rows[0]) >= 4 and '组件' in rows[0][0] else rows):
        if len(row) < 4:
            continue

        component = row[0].strip()
        version = row[1].strip()
        date_str = row[2].strip()
        change = row[3].strip() if len(row) > 3 else ""
        lesson_ids = row[4].strip() if len(row) > 4 else ""

        if not date_str or date_str == '日期':
            continue

        # Normalize date: MM-DD → 2026-MM-DD (or 2025 for older)
        if re.match(r'\d{2}-\d{2}$', date_str):
            date_str = f"2026-{date_str}"
        elif not re.match(r'\d{4}-', date_str):
            date_str = f"2026-{date_str}"

        title = extract_title_from_change(change)
        root_cause_text = re.sub(r'\*\*.*?\*\*[:\s]*', '', change, count=1).strip()
        if len(root_cause_text) > 300:
            root_cause_text = root_cause_text[:300]

        tags = extract_tags(change)

        eid = f"e{len(entries)+1:03d}"
        entries.append({
            "id": eid,
            "status": "mature",
            "date": date_str,
            "version": version,
            "component": component,
            "title": title,
            "root_cause": root_cause_text,
            "lesson_ids": lesson_ids.replace(' ', ''),
            "tags": tags,
            "synthesized_to": ""
        })

    return entries


def parse_lessons_section(content):
    """Parse §三 教训清单 into lesson dicts."""
    m = re.search(r'## 三、教训清单(.*?)(?=## [四五六七八九]|\Z)', content, re.DOTALL)
    if not m:
        print("WARNING: §三 教训清单 not found")
        return []

    section = m.group(1)
    lines = section.strip().split('\n')
    rows = parse_markdown_table(lines)

    if not rows:
        print("WARNING: No table rows found in §三")
        return []

    lessons = []
    for row in rows:
        if len(row) < 4:
            continue

        lid = row[0].strip()
        if lid in ('#', '教训') or not re.match(r'[TJ]\d+', lid):
            continue

        title_raw = row[1].strip()
        title = re.sub(r'\*\*', '', title_raw)
        title = re.sub(r'~~(.*?)~~', r'\1', title)
        title = title.strip()

        version = row[2].strip()
        detail = row[3].strip() if len(row) > 3 else ""

        # Detect component from version string
        component = ""
        comp_match = re.match(r'([🔌📱🖥️\s]+)', version)
        if comp_match:
            component = comp_match.group(1).strip()
            version = version[comp_match.end():].strip()
        elif version.startswith('JS'):
            component = "JS"

        # Detect superseded
        superseded = detect_superseded(detail + ' ' + title_raw)
        status = "active"
        if superseded and superseded != 'check_manually':
            status = "deprecated"
        elif superseded == 'check_manually':
            status = "review"
            superseded = ""

        tags = extract_tags(detail + ' ' + title)

        lessons.append({
            "id": lid,
            "title": title[:200],
            "version": version,
            "component": component,
            "detail": detail[:500] if len(detail) > 500 else detail,
            "tags": tags,
            "source_entry": "",
            "status": status,
            "superseded_by": superseded if superseded != 'check_manually' else ""
        })

    return lessons


def cross_reference(entries, lessons):
    """Link entries to lessons via lesson_ids field."""
    lesson_map = {l["id"]: l for l in lessons}
    for e in entries:
        if e["lesson_ids"]:
            for lid in e["lesson_ids"].split(','):
                lid = lid.strip()
                if lid in lesson_map and not lesson_map[lid]["source_entry"]:
                    lesson_map[lid]["source_entry"] = e["id"]


def write_csv(filepath, headers, rows):
    with open(filepath, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def main():
    if len(sys.argv) < 3:
        print("Usage: python migrate.py <AGENT_GUIDE.md> <output_data_dir>")
        sys.exit(1)

    guide_path = Path(sys.argv[1])
    data_dir = Path(sys.argv[2])

    if not guide_path.exists():
        print(f"ERROR: {guide_path} not found")
        sys.exit(1)

    print(f"Reading: {guide_path}")
    content = guide_path.read_text(encoding='utf-8')

    print("Parsing §二 演化索引...")
    entries = parse_entries_section(content)
    print(f"  Found {len(entries)} entries")

    print("Parsing §三 教训清单...")
    lessons = parse_lessons_section(content)
    print(f"  Found {len(lessons)} lessons")

    print("Cross-referencing entries ↔ lessons...")
    cross_reference(entries, lessons)

    data_dir.mkdir(parents=True, exist_ok=True)

    entries_path = data_dir / "evolution-entries.csv"
    lessons_path = data_dir / "evolution-lessons.csv"

    write_csv(entries_path, ENTRIES_HEADERS, entries)
    print(f"Written: {entries_path} ({len(entries)} rows)")

    write_csv(lessons_path, LESSONS_HEADERS, lessons)
    print(f"Written: {lessons_path} ({len(lessons)} rows)")

    # Summary
    status_counts = {}
    for l in lessons:
        s = l["status"]
        status_counts[s] = status_counts.get(s, 0) + 1
    print(f"\nLesson status: {status_counts}")

    linked = sum(1 for l in lessons if l["source_entry"])
    print(f"Lessons with source_entry: {linked}/{len(lessons)}")

    print("\nMigration complete. Review the CSV files and adjust as needed.")


if __name__ == "__main__":
    main()
