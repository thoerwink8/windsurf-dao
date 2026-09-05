# 服务器帅位期1：三个动词接住 escalate（#971）

署名 issue #971，关单交给 `scripts/close-issues.mjs`。

## 目标

给服务器指挥官三个确定性动词——`add-label` / `retry-drain` / `open-issue`——让现在喊给空气的 escalate 有接收方。只加动词，不动 `scan` / executor 骨架，不接 LLM，不放宽 `FORBIDDEN_AUTO_KINDS`，不新增 GitHub App。

## 验收标准

1. 三个动词各有纯函数校验层，与执行层分开；调用方填的值过不了就拒。
2. 每个校验都有反证测试：合法样本放行 + 违规样本被拒。
3. 变异测试：把每个校验摘掉必须当场判红。合并证据是「故意违规被当场拦下」，不是「已实现」。
4. 白名单外的 kind 仍然抛异常；`FORBIDDEN_AUTO_KINDS` 一字不放宽。
5. GitHub 写动作走 `gh-as.mjs <role>`，role 做成参数，默认 `marshal`。
6. 服务器真跑一轮：至少有一个 escalate 被这三个动词之一接住。判别性实验：缺 `reviewer/` 的 PR，escalate → `add-label` → 复审票。

## 进展

- 纯函数校验层 `scripts/lib/commander-verbs.mjs`（不 spawn、不读盘）。
- `decide` 接线：半标能推出唯一跨厂值 → `add-label`；队列里上次没成的票 → `retry-drain`（派了 ≠ 成了）；`wake-exhausted` / `rereview-exhausted` / `drain-exhausted` → `open-issue`。
- executor 三个 case，动手前再过一遍 `plan*Cmd`。role 默认 marshal。
- `tests/commander-verbs.test.js` 38 过 / 0 红（含 15 条校验逐条变异：摘掉即放行违规样本）。
- `tests/commander.test.js` 77 过 / 0 红。
- `node scripts/dao-check.mjs` 好的（135 项，7 项跳过）。

### 上线证据（故意违规被当场拦下）

变异表覆盖 `CHECKS` 全部 15 条。每条：基线拒 → 摘掉该校验后同一份违规样本被放行。例如：

- `add-label.prefix`：`type/写码` 基线 `label-prefix`，摘掉放行
- `add-label.cross-vendor`：grok+grok 基线 `same-vendor`，摘掉放行（#843 洞的反向）
- `retry-drain.queue`：不在队列的票基线 `not-in-queue`，摘掉放行
- `open-issue.original`：空原文基线 `no-original`，摘掉放行

### 服务器真盘面（2026-09-05T14:36Z）

`node scripts/commander.mjs scan` 全查成（22 issue / 13 PR / 0 复审队列）。`act --dry-run` 当天盘面只产两条框架活回流（#902/#904），**没有缺 `reviewer/` 的 escalate**——当晚那 5 张靠人工补标的 PR，标签已经补上了。

判别性实验用**当天这份 situation JSON**（不是单元夹具）：

1. 剥掉 attributed #833 的 `reviewer/`（PR #945 的署名单，当晚就是这类洞）→ `decide` 产 `add-label`：`issue 833 / pr 945 / reviewer/gpt-5.6-luna`，argv `node scripts/gh-as.mjs marshal -- issue edit 833 --add-label reviewer/gpt-5.6-luna`。
2. 把当天 `rereview:945@749662d2…` 的 tries 提到 3 → `open-issue`，正文含 escalate 原文「PR #945 叫了 3 次审官，当前 head 749662d2 判定仍是 0——停手交人」。

完整「补标 → 复审票 → 审官落判定」要等下一张真缺标的 PR；本跳没有为了验收去改 live 标签。

### 机制判定

这错在制度生效前还会再犯吗？**会**——指挥官每轮仍会碰到半标 / drain 失败 / 唤满，服务器上仍然没有人坐帅位。机制改在本 PR：这三个 escalate 改走确定性动词（校验过不了就拒，不猜），不再喊给空气。LLM decide 是期 2，不在本单。
