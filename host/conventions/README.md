# 约定脊柱（host/conventions/）

跨仓约定的**唯一真相源**。本仓管，子仓只拿副本；子仓的个性留给子仓，共性走这里。

## 谁管

- **本仓管**：`core.md`（不可协商层 C1..C7）、`stacks/*.json`（按栈的机械项基线）、`exemptions.schema.json`（豁免格式）。
- **子仓管**：语言/栈、构建与测试命令、领域规则、目录结构——**不进这里**（本仓不越界）。
- **边界判据**：写「加这条是因为不加会出什么事」写得出来的，才够格进不可协商层；写不出来的走默认继承层或子仓自定。

## 怎么传播（两向）

**自上而下（本仓 → 子仓）**：Golden Path 优先，闸兜底。

1. `stamp.mjs --print` 打出子仓要贴的那行：`<!-- dao-conventions: v<N> sha256:<hex> -->`；
2. 子仓把它贴进 `AGENTS.md`，并把 `{version, sha256}` 抄进 `.dao/conventions.json`（pin）；
3. 子仓 CI 跑 `kit/check-conventions.mjs`——**戳被改旧/被改过就红**；
4. 硬手段只有一条：fleet 拒绝在不符合的子仓起任务（本仓唯一能单方面执行的）。

**自下而上（子仓 → 本仓）**：子仓交卷时 PR 正文写 `## 回流` 段；本仓处置（收 / 不收带理由）。
收件箱与超时闸见 `host/reflow/`。

**子仓接得怎么样**：`host/machine/child-repos.json` 声明子仓清单，`node scripts/conformance.mjs` 出三态报告。
**报告红 = 子仓未接**（确定不存在），**没查成 = 取不到**（网络/权限）——两者不许混。
2026-09-19 第一次跑：0/4 符合（四个子仓都还没接）——这是实话，不是故障。

## 怎么验

| 验什么 | 命令 | 判据 |
|---|---|---|
| 真相源自己的戳与内容对得上、条数 ≤ 7 | `node host/conventions/stamp.mjs` | 绿/红/没查成三态 |
| 子仓的块与 pin 对得上、豁免都带理由 | `node host/conventions/kit/check-conventions.mjs --repo <子仓>` | 退出码 0/1/2 |
| **本仓读子仓**的符合性（声明的子仓清单） | `node scripts/conformance.mjs` | 三态；清单在 `host/machine/child-repos.json` |
| 改过 `core.md` 之后 | `node host/conventions/stamp.mjs --write` | 重算戳（version 不动，升版由人改 `conventions.json`） |

**「已安装」不是证据**：故意把某子仓的戳改旧，必须当场红——这是上线证据（判例：C6）。

## 改这里的规矩

- 改 `core.md` → 必须同一次提交里跑 `stamp.mjs --write`（否则本仓自己红）；
- 往不可协商层加条目 → 要举证（不加会出什么事），且**上限 7 条**，超了检查器直接判红；
- 子仓确实做不到某条 → 走豁免（`## 豁免` 段 + 理由），**不许裸抑制**（C2）。
