## 目标

#793 dao-check 新增项：host/skills 每个 skill 在本机发现面有符号链接（缺链零报警漏洞）。仓内新增 skill 后宿主（Claude Code）发现面靠 `~/.claude/skills/<名>` 的符号链接直连仓内，建链是手动动作（NEW-MACHINE §11，#565 拍板 symlink 归帅建），没有任何防线提醒「新增了 skill 该建链」——#789 实咬过。本单给 dao-check 加检查：扫 `host/skills/*/` 每个目录，断言本机 `~/.claude/skills/<名>` 存在且是指向仓内 `host/skills/<名>` 的符号链接；缺链/指错报红，不自动建链，CI 无 `~/.claude/skills` 走 SKIP 不是绿。

## 验收标准

- [x] `node scripts/dao-check.mjs` 新增一项：扫 `host/skills/*/` 每个目录，断言本机 `~/.claude/skills/<名>` 存在且是指向仓内 `host/skills/<名>` 的符号链接；缺链/指错 → 报红
- [x] 该项不自动建链（保持「symlink 归帅建」#565），只报警
- [x] 故意删掉一个链接 → dao-check 该项报红（构造违规样本被拦才算生效，含单测红样本 + 本机实测）
- [x] CI 无本机 `~/.claude/skills` → 该项 SKIP（不是绿）
- [x] `node --test tests/skill-link.test.js` 15/15 过；全套 `node --test tests/*.test.js` 3228 条 0 红；`node scripts/dao-check.mjs` 全绿（93 项，7 项跳过）

## 进展

- [x] 开工：空提交撑分支 + draft PR（PR #810）
- [x] `scripts/lib/skill-link-check.mjs`：自发现扫 `host/skills/*/`，逐目录断言 `~/.claude/skills/<名>` 是符号链接且 realpath 落点以 `host/skills/<名>` 结尾（worktree/主仓两种 checkout 都认，指错 skill / 指到别处 / 普通目录 / 悬空 / 缺链分别报红）；本机无 `~/.claude/skills` → SKIP 不是绿；0 个 skill = 没查成；只报警不自动建链
- [x] dao-check 注册（㉘）：`checkSkillLinksAlive()` 接线 green/skip/fail 三槽位
- [x] `tests/skill-link.test.js`（判别力回归网 15 断言：绿 = 全链齐 / 指向另一 checkout；红 = 缺链 / 普通目录 / 悬空 / 指错 skill / 指到别处；SKIP = 无 `~/.claude/skills`；没查成 = host/skills 不在 / 空 / HOME 空）
- [x] 本机实测验收 #3：`mv ~/.claude/skills/dao-commit` 后 dao-check 该项报「dao-commit: 缺链」，恢复后转绿「14 个已接」
- [x] `node scripts/dao-redact.mjs --scan` 新文件零命中
- [x] dao-check 全绿 → ready

### 验收记录

- **缺链报红**：删 `~/.claude/skills/dao-commit` → `skill 发现面缺链/指错 1 个（共 14 个 skill）` + `dao-commit: 缺链`；恢复 → `ok skill 发现面符号链接 14 个已接`
- **判别力**：单测 15 条覆盖绿/红/SKIP/没查成四态（指向另一 checkout 也绿——部署事实是本机只给主仓 checkout 建链，worktree 不假红）
- **全套回归**：3228 测试 0 红（9 跳过 = Windows-only junction 样本）；dao-check 93 项绿

署名 issue #793，关单交给 `scripts/close-issues.mjs`。
