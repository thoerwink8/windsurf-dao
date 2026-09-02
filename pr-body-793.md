## 目标

#793 dao-check 新增项：host/skills 每个 skill 在本机发现面有符号链接（缺链零报警漏洞）。仓内新增 skill 后宿主（Claude Code）发现面靠 `~/.claude/skills/<名>` 的符号链接直连仓内，建链是手动动作（NEW-MACHINE §11，#565 拍板 symlink 归帅建），没有任何防线提醒「新增了 skill 该建链」——#789 实咬过。本单给 dao-check 加检查：扫 `host/skills/*/` 每个目录，断言本机 `~/.claude/skills/<名>` 存在且是指向仓内 `host/skills/<名>` 的符号链接；缺链/指错报红，不自动建链，CI 无发现面走 SKIP 不是绿。

## 验收标准

- [x] `node scripts/dao-check.mjs` 新增一项：扫 `host/skills/*/` 每个目录，断言本机 `~/.claude/skills/<名>` 存在且是指向仓内 `host/skills/<名>` 的符号链接；缺链/指错 → 报红
- [x] 该项不自动建链（保持「symlink 归帅建」#565），只报警
- [x] 故意删掉一个链接 → dao-check 该项报红（单测红样本 + 本机实测）
- [x] CI 语境 → 该项 SKIP（不是绿）；本机同样的部分缺链状态仍报红（与 check.yml 预步骤同形的回归样本）
- [x] 归属校验：落点必须属于本仓（common-dir 相同）——无关仓库的同名 `host/skills/<名>` 报红；同仓另一 checkout（worktree）仍绿；git 归属解不出 = 没查成，不许纯后缀放行
- [x] `node --test tests/skill-link.test.js` 21/21 过；全套 3234 条 0 红；`node scripts/dao-check.mjs` 全绿；PR check（CI）转绿

## 进展

- [x] 开工：空提交撑分支 + draft PR（PR #810）
- [x] `scripts/lib/skill-link-check.mjs`：自发现扫 `host/skills/*/`，逐目录断言 `~/.claude/skills/<名>` 是符号链接；两道门——① realpath 落点以 `host/skills/<名>` 结尾；② 落点 git common-dir == 本仓 common-dir（手工解析 .git 文件/gitdir/commondir，不 shell git；worktree/主仓两种形态都认）。缺链/普通目录/悬空/指错 skill/指到布局外/指到无关仓分别报红；CI 语境或本机无 `~/.claude/skills` → SKIP 不是绿；0 个 skill / root 不在 git 仓 = 没查成
- [x] dao-check 注册（㉘）：`checkSkillLinksAlive()` 接线 green/skip/fail 三槽位，传 isCi（GITHUB_ACTIONS/CI 置真）
- [x] `tests/skill-link.test.js`（判别力回归网 21 断言：绿 = 全链齐 / 同仓 worktree 指向主仓；红 = 缺链 / 普通目录 / 悬空 / 指错 skill / 指到布局外 / 无关仓同名布局 / 目标非 git 仓；SKIP = 无 `~/.claude/skills` / CI 预步骤同形样本（只链 hook skill）+ isCi；没查成 = host/skills 不在 / 空 / HOME 空 / root 不在 git 仓）
- [x] 本机实测验收 #3：删 `~/.claude/skills/dao-commit` → 报「dao-commit: 缺链」；恢复 → 「14 个已接」绿
- [x] 审官红 1 修复：CI 预步骤（check.yml 只为带 hook 的 skill 建链）会把发现面判缺链打红真实 check → 显式 isCi 上下文 SKIP；本机同状态仍红（⑩ 样本双断言）
- [x] 审官红 2 修复：后缀判据会把无关仓库误认仓内 → 加 common-dir 归属校验；无关仓同名布局红样本 + 同仓 worktree 绿样本都进回归网
- [x] PR check（CI）转绿；dao-check 全绿 → 交卷

### 验收记录

- **缺链报红**：删 `~/.claude/skills/dao-commit` → `skill 发现面缺链/指错 1 个（共 14 个 skill）` + `dao-commit: 缺链`；恢复 → `ok skill 发现面符号链接 14 个已接`
- **CI 语境 SKIP**：CI=true 模拟 check.yml 预步骤同形状态（~/.claude/skills 已建、只链 hook skill）→ SKIP 不是绿；同状态不标 CI → 红（⑩ 样本）
- **无关仓误认修复**：`~/.claude/skills/demo → /tmp/.../unrelated-repo/host/skills/demo` → 报 `指错 → ...（目标仓 common-dir=... ≠ 本仓 ...）`；同仓 worktree 指向主仓 → 绿（⑧/② 样本）
- **全套回归**：3234 测试 0 红（9 跳过 = Windows-only junction 样本）；dao-check 93 项绿；PR check（ubuntu-latest 真实工作流）绿

署名 issue #793，关单交给 `scripts/close-issues.mjs`。
