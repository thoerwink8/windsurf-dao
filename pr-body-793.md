## 目标

#793 dao-check 新增项：host/skills 每个 skill 在本机发现面有符号链接（缺链零报警漏洞）。仓内新增 skill 后宿主（Claude Code）发现面靠 `~/.claude/skills/<名>` 的符号链接直连仓内，建链是手动动作（NEW-MACHINE §11，#565 拍板 symlink 归帅建），没有任何防线提醒「新增了 skill 该建链」——#789 实咬过。本单给 dao-check 加检查：扫 `host/skills/*/` 每个目录，断言本机 `~/.claude/skills/<名>` 存在且是指向仓内 `host/skills/<名>` 的符号链接；缺链/指错报红，不自动建链，CI 无 `~/.claude/skills` 走 SKIP 不是绿。

## 验收标准

- [x] `node scripts/dao-check.mjs` 新增一项：扫 `host/skills/*/` 每个目录，断言本机 `~/.claude/skills/<名>` 存在且是指向仓内 `host/skills/<名>` 的符号链接；缺链/指错 → 报红
- [x] 该项不自动建链（保持「symlink 归帅建」#565），只报警
- [x] 故意删掉一个链接 → dao-check 该项报红（构造违规样本被拦才算生效，含单测红样本 + 本机实测）
- [x] CI 无本机 `~/.claude/skills` → 该项 SKIP（不是绿）
- [x] `node --test tests/skill-link.test.js` 全过；`node scripts/dao-check.mjs` 绿（本机仅余既有环境红：orca ENOENT / ⑧ 装载面 / 账本断流）

## 进展

- [x] 开工：空提交撑分支 + draft PR
- [x] `scripts/lib/skill-link-check.mjs`：自发现扫 `host/skills/*/`，逐目录断言 `~/.claude/skills/<名>` 是符号链接且 realpath 落点以 `host/skills/<名>` 结尾（worktree/主仓两种 checkout 都认，指错 skill / 指到别处 / 普通目录 / 悬空 / 缺链分别报红）；本机无 `~/.claude/skills` → SKIP 不是绿；0 个 skill = 没查成
- [x] dao-check 注册（㉘）：`checkSkillLinksAlive()` 接线 green/skip/fail 三槽位
- [x] `tests/skill-link.test.js`（判别力回归网：绿样本 = 全链齐 / 指向另一 checkout；红样本 = 缺链 / 普通目录 / 悬空 / 指错 skill / 指到别处；SKIP 样本 = 无 `~/.claude/skills`；零样本 = 空 host/skills）
- [x] 本机实测：故意删 `~/.claude/skills/dao-commit` 链接 → dao-check 该项报红；恢复后转绿
- [x] dao-check 绿（仅余既有环境红）→ ready

署名 issue #793，关单交给 `scripts/close-issues.mjs`。
