#!/usr/bin/env node
// clause-sources.mjs — 条款源清单的机器出口（一行 JSON，{sources:[...]} 形状）
//
// 消费方：check-clauses-structure.ps1 的缺省全量模式（「这次该检哪几份」不问人、
// 不手维护，向这里要）。清单的真相源是 lib/clause-parser.mjs 的 defaultSources()——
// 本文件只是它的打印出口（补上 abs/exists/ps_selector 三个机器面字段），
// 没有第二份清单。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSources, defaultPsSelectorMap } from "../lib/clause-parser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const psMap = defaultPsSelectorMap();
const sources = defaultSources().map((s) => {
  const abs = path.join(ROOT, s.file);
  return { file: s.file, abs, exists: fs.existsSync(abs), ps_selector: psMap[s.file] || null, selector: s.selector, role_scheme: s.role_scheme };
});
process.stdout.write(JSON.stringify({ sources }) + "\n");
