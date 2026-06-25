#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dao-evolution core — BM25 search engine for evolution records.
"""

import csv
import re
import sys
from pathlib import Path
from math import log
from collections import defaultdict
from datetime import date

ENTRIES_FILE = "evolution-entries.csv"
LESSONS_FILE = "evolution-lessons.csv"

ENTRIES_HEADERS = ["id", "date", "title", "summary", "lesson_ids", "tags"]
LESSONS_HEADERS = ["id", "date", "title", "insight", "tags"]

ENTRIES_SEARCH_COLS = ["title", "summary", "tags"]
LESSONS_SEARCH_COLS = ["title", "insight", "tags"]

MAX_RESULTS = 5


class BM25:
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


def init_data(data_dir):
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


def search_entries(data_dir, query, max_results=MAX_RESULTS):
    filepath = Path(data_dir) / ENTRIES_FILE
    return _search_csv(filepath, ENTRIES_SEARCH_COLS, query, max_results)


def search_lessons(data_dir, query, max_results=MAX_RESULTS):
    filepath = Path(data_dir) / LESSONS_FILE
    return _search_csv(filepath, LESSONS_SEARCH_COLS, query, max_results)


def search_all(data_dir, query, max_results=MAX_RESULTS):
    entries = search_entries(data_dir, query, max_results)
    lessons = search_lessons(data_dir, query, max_results)
    return {"entries": entries, "lessons": lessons}


def stats(data_dir):
    data_dir = Path(data_dir)
    entries = _load_csv(data_dir / ENTRIES_FILE)
    lessons = _load_csv(data_dir / LESSONS_FILE)

    latest_date = ""
    for e in entries:
        d = e.get("date", "")
        if d > latest_date:
            latest_date = d

    return {
        "entries_total": len(entries),
        "lessons_total": len(lessons),
        "latest_entry_date": latest_date or "N/A"
    }


def next_entry_id(data_dir):
    entries = _load_csv(Path(data_dir) / ENTRIES_FILE)
    max_n = 0
    for e in entries:
        eid = e.get("id", "")
        if eid.startswith("E"):
            try:
                n = int(eid[1:])
                if n > max_n:
                    max_n = n
            except ValueError:
                pass
    return f"E{max_n + 1}"


def next_lesson_id(data_dir):
    lessons = _load_csv(Path(data_dir) / LESSONS_FILE)
    max_n = 0
    for l in lessons:
        lid = l.get("id", "")
        if lid.startswith("L"):
            try:
                n = int(lid[1:])
                if n > max_n:
                    max_n = n
            except ValueError:
                pass
    return f"L{max_n + 1}"


def write_entry(data_dir, title, summary, lesson_ids="", tags=""):
    data_dir = Path(data_dir)
    init_data(data_dir)
    eid = next_entry_id(data_dir)
    row = {
        "id": eid,
        "date": date.today().isoformat(),
        "title": title,
        "summary": summary,
        "lesson_ids": lesson_ids,
        "tags": tags,
    }
    _append_csv(data_dir / ENTRIES_FILE, ENTRIES_HEADERS, row)
    return eid


def write_lesson(data_dir, title, insight, tags=""):
    data_dir = Path(data_dir)
    init_data(data_dir)
    lid = next_lesson_id(data_dir)
    row = {
        "id": lid,
        "date": date.today().isoformat(),
        "title": title,
        "insight": insight,
        "tags": tags,
    }
    _append_csv(data_dir / LESSONS_FILE, LESSONS_HEADERS, row)
    return lid
