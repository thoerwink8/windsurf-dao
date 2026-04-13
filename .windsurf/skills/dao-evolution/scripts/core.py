#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dao-evolution core — BM25 search engine for evolution records.
Handles CSV loading, indexing, searching, writing, and initialization.
"""

import csv
import re
import os
import sys
from pathlib import Path
from math import log
from collections import defaultdict
from datetime import date

# ============ CONFIGURATION ============

ENTRIES_FILE = "evolution-entries.csv"
LESSONS_FILE = "evolution-lessons.csv"

ENTRIES_HEADERS = [
    "id", "status", "date", "version", "component",
    "title", "root_cause", "lesson_ids", "tags", "synthesized_to"
]

LESSONS_HEADERS = [
    "id", "title", "version", "component",
    "detail", "tags", "source_entry", "status", "superseded_by"
]

ENTRIES_SEARCH_COLS = ["title", "root_cause", "tags", "component"]
LESSONS_SEARCH_COLS = ["title", "detail", "tags", "component"]

MAX_RESULTS = 5


# ============ BM25 IMPLEMENTATION ============

class BM25:
    """BM25 ranking algorithm for text search."""

    def __init__(self, k1=1.5, b=0.75):
        self.k1 = k1
        self.b = b
        self.corpus = []
        self.doc_lengths = []
        self.avgdl = 0
        self.idf = {}
        self.doc_freqs = defaultdict(int)
        self.N = 0

    def tokenize(self, text):
        text = re.sub(r'[^\w\s]', ' ', str(text).lower())
        return [w for w in text.split() if len(w) > 1]

    def fit(self, documents):
        self.corpus = [self.tokenize(doc) for doc in documents]
        self.N = len(self.corpus)
        if self.N == 0:
            return
        self.doc_lengths = [len(doc) for doc in self.corpus]
        self.avgdl = sum(self.doc_lengths) / self.N

        for doc in self.corpus:
            seen = set()
            for word in doc:
                if word not in seen:
                    self.doc_freqs[word] += 1
                    seen.add(word)

        for word, freq in self.doc_freqs.items():
            self.idf[word] = log((self.N - freq + 0.5) / (freq + 0.5) + 1)

    def score(self, query):
        query_tokens = self.tokenize(query)
        scores = []

        for idx, doc in enumerate(self.corpus):
            s = 0
            doc_len = self.doc_lengths[idx]
            term_freqs = defaultdict(int)
            for word in doc:
                term_freqs[word] += 1

            for token in query_tokens:
                if token in self.idf:
                    tf = term_freqs[token]
                    idf_val = self.idf[token]
                    numerator = tf * (self.k1 + 1)
                    denominator = tf + self.k1 * (1 - self.b + self.b * doc_len / self.avgdl)
                    s += idf_val * numerator / denominator

            scores.append((idx, s))

        return sorted(scores, key=lambda x: x[1], reverse=True)


# ============ CSV I/O ============

def _load_csv(filepath):
    if not filepath.exists():
        return []
    with open(filepath, 'r', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def _append_csv(filepath, headers, row_dict):
    exists = filepath.exists() and filepath.stat().st_size > 0
    with open(filepath, 'a', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        if not exists:
            writer.writeheader()
        writer.writerow(row_dict)


def _rewrite_csv(filepath, headers, rows):
    with open(filepath, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


# ============ INITIALIZATION ============

def init_data(data_dir):
    """Create data directory and empty CSV files with headers if they don't exist."""
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    created = []

    for fname, headers in [(ENTRIES_FILE, ENTRIES_HEADERS), (LESSONS_FILE, LESSONS_HEADERS)]:
        fpath = data_dir / fname
        if not fpath.exists() or fpath.stat().st_size == 0:
            with open(fpath, 'w', encoding='utf-8', newline='') as f:
                csv.DictWriter(f, fieldnames=headers).writeheader()
            created.append(fname)

    return created


# ============ SEARCH ============

def _search_csv(filepath, search_cols, query, max_results):
    data = _load_csv(filepath)
    if not data:
        return []

    documents = [" ".join(str(row.get(col, "")) for col in search_cols) for row in data]

    bm25 = BM25()
    bm25.fit(documents)
    ranked = bm25.score(query)

    results = []
    for idx, score in ranked[:max_results]:
        if score > 0:
            row = data[idx]
            row["_score"] = round(score, 2)
            results.append(row)

    return results


def search_entries(data_dir, query, max_results=MAX_RESULTS, status_filter=None):
    """Search evolution entries."""
    filepath = Path(data_dir) / ENTRIES_FILE
    results = _search_csv(filepath, ENTRIES_SEARCH_COLS, query, max_results * 2)

    if status_filter:
        results = [r for r in results if r.get("status") in status_filter]

    return results[:max_results]


def search_lessons(data_dir, query, max_results=MAX_RESULTS, status_filter=None):
    """Search evolution lessons. By default excludes deprecated."""
    filepath = Path(data_dir) / LESSONS_FILE
    results = _search_csv(filepath, LESSONS_SEARCH_COLS, query, max_results * 2)

    if status_filter is None:
        status_filter = ["active", "review"]

    results = [r for r in results if r.get("status") in status_filter]
    return results[:max_results]


def search_all(data_dir, query, max_results=MAX_RESULTS):
    """Search both entries and lessons, return combined results."""
    entries = search_entries(data_dir, query, max_results)
    lessons = search_lessons(data_dir, query, max_results)
    return {"entries": entries, "lessons": lessons}


# ============ STATS ============

def stats(data_dir):
    """Return summary statistics."""
    data_dir = Path(data_dir)
    entries = _load_csv(data_dir / ENTRIES_FILE)
    lessons = _load_csv(data_dir / LESSONS_FILE)

    entry_counts = defaultdict(int)
    for e in entries:
        entry_counts[e.get("status", "unknown")] += 1

    lesson_counts = defaultdict(int)
    for l in lessons:
        lesson_counts[l.get("status", "unknown")] += 1

    latest_date = ""
    for e in entries:
        d = e.get("date", "")
        if d > latest_date:
            latest_date = d

    return {
        "entries_total": len(entries),
        "entries_by_status": dict(entry_counts),
        "lessons_total": len(lessons),
        "lessons_by_status": dict(lesson_counts),
        "latest_entry_date": latest_date or "N/A"
    }


# ============ WRITE ============

def next_entry_id(data_dir):
    entries = _load_csv(Path(data_dir) / ENTRIES_FILE)
    max_n = 0
    for e in entries:
        eid = e.get("id", "")
        if eid.startswith("e"):
            try:
                n = int(eid[1:])
                if n > max_n:
                    max_n = n
            except ValueError:
                pass
    return f"e{max_n + 1:03d}"


def next_lesson_id(data_dir):
    lessons = _load_csv(Path(data_dir) / LESSONS_FILE)
    max_n = 0
    for l in lessons:
        lid = l.get("id", "")
        if lid.startswith("T"):
            try:
                n = int(lid[1:])
                if n > max_n:
                    max_n = n
            except ValueError:
                pass
    return f"T{max_n + 1}"


def write_entry(data_dir, status, version, component, title, root_cause, lesson_ids="", tags=""):
    """Write a new evolution entry."""
    data_dir = Path(data_dir)
    init_data(data_dir)
    eid = next_entry_id(data_dir)
    row = {
        "id": eid,
        "status": status,
        "date": date.today().isoformat(),
        "version": version,
        "component": component,
        "title": title,
        "root_cause": root_cause,
        "lesson_ids": lesson_ids,
        "tags": tags,
        "synthesized_to": ""
    }
    _append_csv(data_dir / ENTRIES_FILE, ENTRIES_HEADERS, row)
    return eid


def write_lesson(data_dir, title, version, component, detail, tags="", source_entry=""):
    """Write a new evolution lesson."""
    data_dir = Path(data_dir)
    init_data(data_dir)
    lid = next_lesson_id(data_dir)
    row = {
        "id": lid,
        "title": title,
        "version": version,
        "component": component,
        "detail": detail,
        "tags": tags,
        "source_entry": source_entry,
        "status": "active",
        "superseded_by": ""
    }
    _append_csv(data_dir / LESSONS_FILE, LESSONS_HEADERS, row)
    return lid


def deprecate_lesson(data_dir, lesson_id, superseded_by):
    """Mark a lesson as deprecated."""
    data_dir = Path(data_dir)
    fpath = data_dir / LESSONS_FILE
    lessons = _load_csv(fpath)
    updated = False
    for l in lessons:
        if l.get("id") == lesson_id:
            l["status"] = "deprecated"
            l["superseded_by"] = superseded_by
            updated = True
            break
    if updated:
        _rewrite_csv(fpath, LESSONS_HEADERS, lessons)
    return updated


def mark_synthesized(data_dir, entry_ids, target_entry_id):
    """Mark entries as synthesized, pointing to the target entry."""
    data_dir = Path(data_dir)
    fpath = data_dir / ENTRIES_FILE
    entries = _load_csv(fpath)
    count = 0
    for e in entries:
        if e.get("id") in entry_ids:
            e["status"] = "synthesized"
            e["synthesized_to"] = target_entry_id
            count += 1
    if count:
        _rewrite_csv(fpath, ENTRIES_HEADERS, entries)
    return count


def flag_stale_lessons(data_dir, max_versions_behind=5):
    """Flag active lessons that are too far behind the latest version as 'review'."""
    data_dir = Path(data_dir)
    fpath = data_dir / LESSONS_FILE
    lessons = _load_csv(fpath)
    if not lessons:
        return []

    def parse_version(v):
        nums = re.findall(r'\d+', str(v))
        return tuple(int(n) for n in nums) if nums else (0,)

    entries = _load_csv(data_dir / ENTRIES_FILE)
    all_versions = [parse_version(e.get("version", "")) for e in entries]
    all_versions += [parse_version(l.get("version", "")) for l in lessons]
    if not all_versions:
        return []
    latest = max(all_versions)

    flagged = []
    for l in lessons:
        if l.get("status") != "active":
            continue
        v = parse_version(l.get("version", ""))
        if len(latest) >= 2 and len(v) >= 2:
            if latest[1] - v[1] >= max_versions_behind:
                l["status"] = "review"
                flagged.append(l.get("id"))

    if flagged:
        _rewrite_csv(fpath, LESSONS_HEADERS, lessons)

    return flagged
