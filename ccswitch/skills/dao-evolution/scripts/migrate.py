#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
migrate.py — Auto-discover and migrate evolution data to CSV.

Usage:
  python migrate.py <project_root>           # auto-discover sources
  python migrate.py <project_root> --force    # overwrite existing CSV

Auto-discovers:
  - AGENT_GUIDE.md (table format: §演化索引 + §教训清单)
  - docs/evolution.md (section format: ### date · title)
  - Any combination of the above

Output: <project_root>/data/evolution-{entries,lessons}.csv

Idempotent: skips if CSV already has data, unless --force.
Post-migration: strips old sections from AGENT_GUIDE.md, deletes docs/evolution.md.
"""

import csv
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from core import ENTRIES_HEADERS, LESSONS_HEADERS

# ─── Tag extraction (generic, works for any project) ───

TAG_PATTERNS = [
    r'heartbeat', r'心跳', r'切号', r'switch', r'续传', r'retry',
    r'S0', r'webview', r'Firebase', r'auth', r'认证',
    r'quota', r'配额', r'限流', r'rate.?limit',
    r'vscdb', r'state\.vscdb', r'inject', r'hotSwitch',
    r'protobuf', r'gRPC', r'API', r'DOM', r'CSP',
    r'云端', r'cloud', r'patch', r'timer', r'suspend',
    r'WAM', r'leaderboard', r'consumption', r'消耗',
    r'symlink', r'MCP', r'CLI', r'context', r'skill',
    r'workflow', r'rule', r'always_on', r'model_decision',
    r'autopilot', r'cycle', r'commit', r'deploy',
]


def extract_tags(text):
    found = set()
    for p in TAG_PATTERNS:
        if re.search(p, text, re.IGNORECASE):
            found.add(p.replace(r'.?', '').replace(r'\.', '.').lower())
    return ';'.join(sorted(found))


def extract_bold_title(text):
    m = re.search(r'\*\*(.+?)\*\*', text)
    if m:
        title = m.group(1)
        title = re.sub(r'^[A-Z]\d+[:\s]*', '', title)
        return title[:200]
    return text[:100]


def detect_superseded(detail):
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


# ─── Source discovery ───

def discover_sources(project_root):
    """Find all evolution data sources in a project."""
    root = Path(project_root)
    sources = {}
    for candidate in [
        root / "AGENT_GUIDE.md",
        root / "docs" / "evolution.md",
    ]:
        if candidate.exists():
            sources[candidate.name] = candidate
    return sources


def has_table_format(content):
    """Check if content has table-formatted evolution data."""
    return bool(re.search(r'## [二三]、(演化索引|教训清单)', content))


def has_section_format(content):
    """Check if content has section-formatted evolution data (### date · title)."""
    return bool(re.search(r'###\s+\d{4}[\.\-]\d{2}[\.\-]\d{2}\s+·', content))


# ─── Table format parser (AGENT_GUIDE.md with §二/§三 tables) ───

def parse_markdown_table(lines):
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


def parse_table_entries(content):
    """Parse §二 演化索引 table → entry dicts."""
    m = re.search(r'## 二、演化索引(.*?)(?=## [三四五六七八九]|\Z)', content, re.DOTALL)
    if not m:
        return []

    rows = parse_markdown_table(m.group(1).strip().split('\n'))
    if not rows:
        return []

    # Detect header row
    start = 0
    if len(rows[0]) >= 3 and any(h in rows[0][0] for h in ('组件', '日期', '核心')):
        header = rows[0]
        print(f"    header: {header}")
        start = 1

    entries = []
    for row in rows[start:]:
        if len(row) < 3:
            continue

        # Flexible column detection: could be |组件|版本|日期|变更|教训| or |日期|变更|教训|
        if len(row) >= 5:
            component, version, date_str, change, lesson_ids = row[0], row[1], row[2], row[3], row[4]
        elif len(row) >= 4:
            component, date_str, change, lesson_ids = "", row[0], row[1], row[2] if len(row) > 2 else ""
            version = ""
        else:
            date_str, change = row[0], row[1]
            component = version = lesson_ids = ""

        date_str = date_str.strip()
        if not date_str or date_str in ('日期',):
            continue

        # Normalize date
        if re.match(r'\d{2}-\d{2}$', date_str):
            date_str = f"2026-{date_str}"
        elif not re.match(r'\d{4}', date_str):
            date_str = f"2026-{date_str}"

        title = extract_bold_title(change)
        root_cause = re.sub(r'\*\*.*?\*\*[:\s]*', '', change, count=1).strip()[:300]

        eid = f"e{len(entries)+1:03d}"
        entries.append({
            "id": eid, "status": "mature", "date": date_str,
            "version": version.strip(), "component": component.strip(),
            "title": title, "root_cause": root_cause,
            "lesson_ids": lesson_ids.strip().replace(' ', ''),
            "tags": extract_tags(change), "synthesized_to": ""
        })
    return entries


def parse_table_lessons(content):
    """Parse §三 教训清单 table → lesson dicts."""
    m = re.search(r'## 三、教训清单(.*?)(?=## [四五六七八九]|\Z)', content, re.DOTALL)
    if not m:
        return []

    rows = parse_markdown_table(m.group(1).strip().split('\n'))
    lessons = []
    for row in rows:
        if len(row) < 4:
            continue
        lid = row[0].strip()
        if lid in ('#', '教训') or not re.match(r'[TJ]\d+', lid):
            continue

        title_raw = row[1].strip()
        title = re.sub(r'\*\*', '', title_raw)
        title = re.sub(r'~~(.*?)~~', r'\1', title).strip()

        version = row[2].strip()
        detail = row[3].strip()[:500] if len(row) > 3 else ""

        component = ""
        comp_match = re.match(r'([🔌📱🖥️\s]+)', version)
        if comp_match:
            component = comp_match.group(1).strip()
            version = version[comp_match.end():].strip()
        elif version.startswith('JS'):
            component = "JS"

        superseded = detect_superseded(detail + ' ' + title_raw)
        status = "active"
        if superseded and superseded != 'check_manually':
            status = "deprecated"
        elif superseded == 'check_manually':
            status = "review"
            superseded = ""

        lessons.append({
            "id": lid, "title": title[:200], "version": version,
            "component": component, "detail": detail,
            "tags": extract_tags(detail + ' ' + title),
            "source_entry": "", "status": status,
            "superseded_by": superseded if superseded != 'check_manually' else ""
        })
    return lessons


# ─── Section format parser (docs/evolution.md style) ───

def parse_section_entries_and_lessons(content):
    """Parse ### date · title sections → (entries, lessons)."""
    sections = re.split(r'(?=###\s+)', content)
    entries = []
    lessons = []

    for sec in sections:
        # Match: ### 2026.04.11 · Title
        head = re.match(r'###\s+(\d{4}[\.\-]\d{2}[\.\-]\d{2})\s+·\s+(.+)', sec)
        if not head:
            continue

        date_str = head.group(1).replace('.', '-')
        title = head.group(2).strip()

        # Extract sub-sections
        change_m = re.search(r'\*\*变更\*\*[：:]\s*\n(.*?)(?=\*\*[根教架]|---|\Z)', sec, re.DOTALL)
        cause_m = re.search(r'\*\*根因\*\*[：:]\s*\n(.*?)(?=\*\*[变教架]|---|\Z)', sec, re.DOTALL)
        lesson_m = re.search(r'\*\*教训\*\*[：:]\s*\n(.*?)(?=\*\*[变根架]|---|\Z)', sec, re.DOTALL)

        change_text = change_m.group(1).strip() if change_m else ""
        cause_text = cause_m.group(1).strip() if cause_m else ""
        lesson_text = lesson_m.group(1).strip() if lesson_m else ""

        # Extract lesson IDs from the lesson section
        lesson_ids = re.findall(r'\*\*(T\d+)\*\*', lesson_text)

        eid = f"e{len(entries)+1:03d}"
        entries.append({
            "id": eid, "status": "mature", "date": date_str,
            "version": "", "component": "",
            "title": title[:200],
            "root_cause": cause_text[:300] if cause_text else change_text[:300],
            "lesson_ids": ','.join(lesson_ids),
            "tags": extract_tags(sec), "synthesized_to": ""
        })

        # Parse individual lessons from bullet points
        for lm in re.finditer(r'\*\*(T\d+)\*\*:\s*(.+?)(?=\n- \*\*T\d+|\Z)', lesson_text, re.DOTALL):
            lid = lm.group(1)
            detail = lm.group(2).strip()
            ltitle = detail.split('\n')[0][:200]

            superseded = detect_superseded(detail)
            status = "active"
            if superseded and superseded != 'check_manually':
                status = "deprecated"
            elif superseded == 'check_manually':
                status = "review"
                superseded = ""

            lessons.append({
                "id": lid, "title": ltitle, "version": "",
                "component": "", "detail": detail[:500],
                "tags": extract_tags(detail),
                "source_entry": eid, "status": status,
                "superseded_by": superseded if superseded != 'check_manually' else ""
            })

    return entries, lessons


# ─── Merge & cross-reference ───

def cross_reference(entries, lessons):
    lesson_map = {l["id"]: l for l in lessons}
    for e in entries:
        if e["lesson_ids"]:
            for lid in e["lesson_ids"].split(','):
                lid = lid.strip()
                if lid in lesson_map and not lesson_map[lid]["source_entry"]:
                    lesson_map[lid]["source_entry"] = e["id"]


def dedup_by_id(items):
    """Keep first occurrence of each id."""
    seen = set()
    result = []
    for item in items:
        if item["id"] not in seen:
            seen.add(item["id"])
            result.append(item)
    return result


def write_csv(filepath, headers, rows):
    with open(filepath, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


# ─── Post-migration cleanup ───

CSV_POINTER = """\n> 演化记录已迁移至 `data/evolution-entries.csv` + `data/evolution-lessons.csv`。
> 使用 `search.py` 搜索教训，使用 `search.py stats` 查看统计。
"""


def cleanup_agent_guide(guide_path):
    """Strip evolution table sections from AGENT_GUIDE.md, replace with CSV pointer."""
    content = guide_path.read_text(encoding='utf-8')
    original = content

    # Replace §二 演化索引 section content (keep heading, replace body)
    content = re.sub(
        r'(## 二、演化索引).*?(?=## [三四五六七八九]|\Z)',
        r'\1' + CSV_POINTER + '\n',
        content, flags=re.DOTALL
    )

    # Replace §三 教训清单 section content (keep heading, replace body)
    content = re.sub(
        r'(## 三、教训清单).*?(?=## [四五六七八九]|\Z)',
        r'\1' + CSV_POINTER + '\n',
        content, flags=re.DOTALL
    )

    # Also handle §二 演化记录 variant
    content = re.sub(
        r'(## 二、演化记录).*?(?=## [三四五六七八九]|\Z)',
        r'\1' + CSV_POINTER + '\n',
        content, flags=re.DOTALL
    )

    # Handle bare ## 演化索引 (without 二、 prefix)
    content = re.sub(
        r'(## 演化索引).*?(?=## [^演]|\Z)',
        r'\1' + CSV_POINTER + '\n',
        content, flags=re.DOTALL
    )

    if content != original:
        guide_path.write_text(content, encoding='utf-8')
        print(f"  Cleaned: {guide_path.name} (演化索引/教训清单 → CSV pointer)")
    else:
        print(f"  {guide_path.name}: no evolution sections to clean")


def cleanup_evolution_md(evo_path):
    """Delete docs/evolution.md after migration."""
    if evo_path.exists():
        evo_path.unlink()
        print(f"  Deleted: {evo_path}")
        # Remove empty docs/ dir
        parent = evo_path.parent
        if parent.name == 'docs' and parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
            print(f"  Removed empty: {parent}")


# ─── Main ───

def main():
    if len(sys.argv) < 2:
        print("Usage: python migrate.py <project_root> [--force]")
        sys.exit(1)

    project_root = Path(sys.argv[1])
    force = '--force' in sys.argv

    if not project_root.is_dir():
        print(f"ERROR: {project_root} is not a directory")
        sys.exit(1)

    data_dir = project_root / "data"
    entries_path = data_dir / "evolution-entries.csv"
    lessons_path = data_dir / "evolution-lessons.csv"

    # Idempotent: skip if CSV already has data
    if not force and entries_path.exists() and lessons_path.exists():
        try:
            with open(entries_path, encoding='utf-8') as f:
                reader = csv.reader(f)
                next(reader)  # header
                if sum(1 for _ in reader) > 0:
                    print(f"SKIP: {project_root.name} — CSV already has data (use --force to overwrite)")
                    return
        except (StopIteration, csv.Error):
            pass  # empty/corrupt → proceed

    # Discover sources
    sources = discover_sources(project_root)
    if not sources:
        print(f"SKIP: {project_root.name} — no AGENT_GUIDE.md or docs/evolution.md found")
        return

    print(f"Project: {project_root}")
    print(f"Sources: {', '.join(str(p) for p in sources.values())}")

    all_entries = []
    all_lessons = []

    # Parse each source
    for name, path in sources.items():
        content = path.read_text(encoding='utf-8')
        print(f"\n  Parsing {name}...")

        if has_table_format(content):
            print(f"    Format: table (§演化索引/§教训清单)")
            te = parse_table_entries(content)
            tl = parse_table_lessons(content)
            print(f"    Found {len(te)} entries, {len(tl)} lessons")
            all_entries.extend(te)
            all_lessons.extend(tl)

        if has_section_format(content):
            print(f"    Format: section (### date · title)")
            se, sl = parse_section_entries_and_lessons(content)
            print(f"    Found {len(se)} entries, {len(sl)} lessons")
            all_entries.extend(se)
            all_lessons.extend(sl)

        if not has_table_format(content) and not has_section_format(content):
            print(f"    No recognized evolution format found")

    if not all_entries and not all_lessons:
        print("\nNo evolution data found in any source.")
        return

    # Dedup (section and table may reference same lessons)
    all_lessons = dedup_by_id(all_lessons)

    # Re-number entries sequentially
    for i, e in enumerate(all_entries):
        e["id"] = f"e{i+1:03d}"

    # Cross-reference
    cross_reference(all_entries, all_lessons)

    # Write CSV
    data_dir.mkdir(parents=True, exist_ok=True)
    write_csv(entries_path, ENTRIES_HEADERS, all_entries)
    write_csv(lessons_path, LESSONS_HEADERS, all_lessons)

    # Post-migration cleanup
    print("\nCleaning up old format...")
    guide_path = project_root / "AGENT_GUIDE.md"
    if guide_path.exists():
        cleanup_agent_guide(guide_path)

    evo_path = project_root / "docs" / "evolution.md"
    if evo_path.exists():
        cleanup_evolution_md(evo_path)

    # Summary
    status_counts = {}
    for l in all_lessons:
        status_counts[l["status"]] = status_counts.get(l["status"], 0) + 1

    linked = sum(1 for l in all_lessons if l["source_entry"])
    print(f"\nWritten: {entries_path} ({len(all_entries)} entries)")
    print(f"Written: {lessons_path} ({len(all_lessons)} lessons)")
    print(f"Lesson status: {status_counts}")
    print(f"Lessons with source_entry: {linked}/{len(all_lessons)}")


if __name__ == "__main__":
    main()
