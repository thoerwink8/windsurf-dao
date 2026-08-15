---
name: tauri-migration-integrity
description: "Tauri SQL migration 文件必须在 lib.rs 中注册,否则列缺失导致运行时全面断链;TraceyU 已加 vitest 自动校验"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dddd5bf1-0559-49e9-9fad-39f41793662a
---

Tauri + tauri-plugin-sql 项目中,SQL migration 文件放在 `migrations/` 目录 ≠ 被执行。必须在 Rust `lib.rs` 的 `migrations` vec 中显式注册(include_str! + version)。

**Why:** TraceyU 的 `008_card_suggested_questions.sql` 存在但未注册,导致 `cards` 表缺 `suggested_questions` 列,所有卡片写入操作运行时崩溃。TypeScript 编译通过(类型层面列是 optional),Rust 编译通过(include_str! 没被调用就不报错),静态检查全绿,运行时全断。

**How to apply:** 所有 Tauri 项目必须有 migration 完整性检查(vitest 测试或 check 脚本),校验三件事:
1. 每个 `.sql` 文件在 `lib.rs` 中有 `include_str!` 引用
2. `lib.rs` 不引用不存在的 `.sql` 文件
3. version 编号连续无间隔

TraceyU 已实现: `scripts/__tests__/check-migrations.spec.ts` + `scripts/check-migrations.ts`。

通用教训 [[evolution-patch-vs-loop]]: 手工注册步骤 → 加自动校验闭环,而非加"别忘了注册"的文档提醒。
