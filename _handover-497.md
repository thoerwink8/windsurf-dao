# PR #497 交接材料（本单已关闭止损，材料留给 #530）

**这份文件不进 master**，只留在分支 `thoerwink8/480-478-流转器接管机械动作` 上，供 #530（流转器换路：删掉自建状态机，合并交回 GitHub 原生）取用。

本单为什么关：#530 拍板删掉整层，而 #497 的主体——状态机、合并器（判定行文本解析 + 合并四条件硬查）、单实例锁、心跳——正是要删的那些。继续收口等于把 1000 行推进 master 再由 #530 删掉。已投入 15 轮 / 6 次红判定。**不是实现做砸了，是脚下的前提被换掉了**（共用一个 GitHub 账号 → 用不了原生 review 状态机 → 只好全部自建；换独立身份后这条因果链整根消失，见 #530）。

以下所有行号针对本分支 HEAD 的 `scripts/flow.mjs`（1877 行）。

---

## 一、要带走的两件：起审官 / 返工注入

GitHub 给不了这两件——它不会去开一个 AI 终端。#530 里 flow 缩成「事件触发的派工器」时，活下来的就是它们。

### 1.1 起审官 `executeAction` 的 `start-reviewer` 分支（1286–1349）

链路是四步，**每一步都可能失败，且失败后果不同**：

| 步 | 代码 | 依赖 |
|---|---|---|
| 认 PR 类型 | `classifyPr(pr)` → `{model, taskType}` | PR 上的 `model/*` 与 `type/*` 标签。**缺标签直接失败**（1288） |
| 选审官 | `pickReviewer(toml, model, taskType)`（450） | `docs/model-routing.toml` 的审查角色表 |
| 取启动配方 | `reviewerLaunch(reviewer)`（468） | provider → 启动命令；`twoStep` 决定走两步还是一步 |
| 起工位 | `task-create` → `worker-start` | 见下 |

**两条启动路径不对称，这是坑的来源**：

- `twoStep`（Claude 族）：`worktree create` → `terminal create --command <启动命令>` → `worker-start --task --worktree --terminal`（1331–1339）
- 非 twoStep：直接 `worker-start --task --worktree current --agent --model`（1341）

**换成 orca 原生 `worker_done` 触发后要改的地方**：
- 触发端改掉即可，**上面四步本身不用动**——它们不依赖轮询，也不依赖本地状态。
- 唯一与本地状态的耦合是 1645 行附近把 `exec.taskId` 记进 `rec`（用于后续复核注入寻址）。换路后若复核也走原生消息，这条记账可以一并删；若仍要"找回上次那个审官工位"，改用 `worktree ps` 的 `linkedPR` 字段反查，不要再自己记账。

### 1.2 返工注入 `inject-rework`（1351–1382）

```
workerDispatchFor(source, pr, rec)   → 找到工人的 dispatchId
resolveDeliveryHandle(source, id)    → dispatchId → 终端 handle
deliverFollowUp(taskSpec, handle)    → task-create + worker-start --terminal
```

**关键设计点（这条是十五轮里唯一"先出事后修"的改动，别改回去）**：投递目标只用**结构事实**定位，三条路径按优先级——① flow 自己起的工位用 `rec.workerDispatch` 反向索引；② `dispatchId → worktree → branch` 与 PR `headRefName` **全等**比较；③ 定不出唯一就**报帅转交，不猜**。

**硬禁**：不许用任务书文本子串判归属。真实事故：任务书里写着「合并顺序 #502 → #497」，子串匹配把 #502 的返工派进了 #497 的工位，连锁导致另一个工人 3 个文件的未提交在制品被抹掉且无法恢复。

`inject-recheck`（1384+）是同样结构的复核注入，区别只在找的是审官工位而非工人工位。

---

## 二、会跟着活下来的已知缺陷

### 2.1 start-reviewer 假待办（最重要，换路后仍在）

**现象**：`orca worktree ps` 实查审官树已建好、agent 正在跑，而 flow 记「注入失败、reviewer: null」。审官起成功了，flow 判它失败。三例：#513 / #514 / #528。

**机制**（读 1330–1339 得出，这三例的审官树已被清理，无法回放复现，所以机制是从代码推的，标注清楚以免被当成实证）：`twoStep` 路径是三个独立命令。**`terminal create --command <启动命令>` 这一步就已经把 agent 进程拉起来了**，`worker-start` 只是随后把它纳入编排。所以只要 `worker-start`（1337）失败，就会留下一个**已经起来、但没被编排接管**的审官——资源真实存在，flow 的返回值却是失败。

**为什么换路后还在**：这是「起审官」这件事自带的毛病，与状态机无关。#530 保留起审官，就保留了它。

**可用的结构化判据**（字段已实证，2026-08-16 于 `orca worktree ps --json` 实查）：

```
worktrees[].agents[]  →  { paneKey, state, agentType, prompt, taskTitle,
                           displayName, lastAssistantMessage, toolName,
                           toolInput, interrupted, stateStartedAt, updatedAt }
```

实查样本：审官树 `497-审官-gpt-5.6-sol` 的 `agents[0].state = "done"`。同层还有 `linkedPR` 字段可用于「这棵树是给哪个 PR 的」反查。

**修法方向**（不是定论）：起审官失败时不要只看命令返回值，回查一次 `worktree ps` 的 `agents[].state` 与 `linkedPR`——**资源在不在，比命令说没说成功更可信**。注意这与 #524 是同一族问题的两面：#524 是「命令说成功但工人没开工」，本条是「命令说失败但工人已经起来」。**两条都说明同一件事：`worker-start` 的返回值不足以判断真实状态。**

### 2.2 复核注入依赖自记的 dispatchId

`inject-recheck`（1391）在没有「起审官时记下的 dispatchId」时直接失败。换路后如果不再自己记账，这条要改成用 `linkedPR` / `worktree ps` 反查，否则会变成新的假待办。

---

## 三、踩过、且下一个人还会踩的坑

只写非显然、且**不在 memory 里**的。已进 memory 的（orca JSON 字段路径、`deliveryId` 为空的两种情形、`check --wait` 禁接管道、`worker-start` 返回成功≠开工、判绿只对当时那个 commit 有效、PR 冲突时 CI 压根不触发）不复述。

1. **测试里起长驻进程 = 生产事故，不是测试问题。**
   本单的单实例锁测试为验证「第二个实例会被拒绝」，必须真起 `flow.mjs` 实例。退出路径没兜住，留下七个孤儿在**真仓库**上跑真流转（一个 `--interval 2` 跑了 80 分钟），打到 GitHub secondary rate limit，全仓所有 agent 的 REST 调用被拒。
   **要害不是忘了清理进程**：这个测试的爆炸半径就是生产系统本身——它有能力真的去合并一个 PR。与仓规「检查器的输出不能落在它自己会读取的文件范围内」同族：**测试的副作用落进了被测系统的真实作用域**。
   换路后没有长驻进程，这类测试连同爆炸半径一起消失——**这本身就是换路的一条收益**。

2. **拆掉一个机制会让它的测试变成死循环。**
   第十五轮拆掉 `acquireFlowLock` 后，锁测试里那个「本该被拒绝」的实例**不再有锁去拒绝它**，于是正常进入流转循环、永不退出，测试永远等它 → 工人挂死 21 分钟。**拆机制时必须同一次拆掉它的测试**，否则测试会以最难诊断的形态（挂起而非报错）失败。

3. **判定行解析必须行首锚定，且要吃掉引用/列表前缀。**
   `JUDGMENT_LINE_RE` 形如 `/^\s*(?:[>*]\s*)*(判定|复核结论)/`。搜全文会被 review 正文里**引用的代码**骗过——帅的会话内垫片就是这么被骗的。换路后判定行整体消失（改用原生 APPROVE），但如果过渡期还要读，照抄这个形状。

4. **`orca` 是原生 exe，`spawnSync(cmd, argsArray)` 不丢引号；但转发已拆开的 argv 会丢。**
   本单实咬过一次（`dao.mjs raw`）。写调用层时别自己拼 shell 字符串。

---

## 四、确认不用带走的（别以为是漏了）

以下全部随「删掉自建状态机」一起消失，**不是遗漏，是刻意不带**：

| 东西 | 为什么不用带 |
|---|---|
| `deriveState` / `fingerprint(derived)` / `rec.actedOn` 幂等 | 换路后没有本地状态，也就没有「同一事件重复动作」的问题——GitHub 自己是幂等的 |
| `pendingShuai` 待帅记账 + 它的解除路径（#523） | PR 停在那儿本身就是可见状态，不需要本地再记一份；#523 的原候选方向已被判为第 3 层补丁 |
| `_flow/flow.lock` 单实例锁（#522） | 没有长驻进程就没有多实例 |
| `_flow/heartbeat.json` 心跳 + 看门狗盯流转器 | 没有进程要盯。注意 `watchdog.mjs`（#505，已在 master）里有一处注释写着「由 dao-check ⑧ 心跳闸兜底」，**换路时要一并处理那条依赖**，别留成悬空引用 |
| 合并四条件硬查（判定绿 / CI 全绿 / `merge/auto` 标签 / `review.commit_id == headRefOid`） | ruleset 的 required checks + required approving reviews 覆盖前三条；第四条对应 ruleset 的 `require_last_push_approval`（**参数名待实配时核对，我没实配过**） |
| GitHub 轮询 | ruleset + `gh pr merge --auto` 是服务端行为，不需要有人盯 |

**第四条那个「判绿的 commit 必须等于当前 HEAD」值得单独说一句**：它在本单是靠自建实现的，而它拦住的第一个 PR 就是 #497 自己——当时唯一带判定行的 review 停在 `cc53837e`，HEAD 已经走到 `3cbebba7`，中间隔着四轮未经审读的改动，其中三轮改的就是合并闸本身。差一点被合并，**拦住它的是人眼看时间戳对不上，不是任何机制**。换路后这条闸由 GitHub 提供，但**上线时要确认它真的开了**，别默认有。

---

## 五、留在分支上的东西

- `scripts/flow.mjs`（1877 行）：起审官/返工注入见第一节，其余按第四节处置
- `scripts/lib/judgment.mjs`：判定行解析单一真相源，过渡期若还要读判定行就用它
- `tests/flow.tests.js` + `tests/flow-fixtures/`：约 300 断言。**其中 `tests/fixtures/orca-returns/` 是 orca 各命令的真实返回存档**（注明了采集命令与日期）——这批东西与流转器的设计无关，**换路后仍然有用**，建议移到 #530 或独立留存，别跟着 flow.mjs 一起丢。
- `scripts/dao-check.mjs` 的心跳闸（⑦⑧）：换路后随心跳一起撤

---

*写于 2026-08-16，PR #497 关闭止损时。*
