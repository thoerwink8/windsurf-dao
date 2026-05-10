# dao-mantra × superpowers-gate 互引升级 plan

**任务**：让两个 always_on 规则文件互相 reference，形成「心境（mantra）→ 判定（gate）→ 落地（workflow）」清晰分工。

**worktree**：`D:\frank\windsurf-dao-worktrees\mantra-gate-cross-ref`
**branch**：`feat/mantra-gate-cross-ref`
**base**：master @ 4e40903

## 背景

v3 升级中创建了 `dao-mantra.md`（心怀八句，always_on）。`superpowers-gate.md` 早于 mantra 存在，未引用 mantra。两文件都是 always_on，每次对话同时加载，但**关系未明示**——AI 容易把两者当成并列规则而非「心境 → 判定」前后关系。

## 改动范围

2 文件，预计 ≤20 行净增。

### 改动 1 · `.windsurf/rules/dao-mantra.md`

**1a · 场景速查表 L31 补充 gate 引用**

```diff
- | 工程仪式五步 | `/dao-superpowers` | 致虚守静 (16) + 慎终如始 (64) |
+ | 工程仪式五步 | `superpowers-gate.md` 判定 + `/dao-superpowers` 落地 | 致虚守静 (16) + 慎终如始 (64) |
```

**1b · 「协同」段 L38 精修描述**

```diff
- - `superpowers-gate.md` (always_on 门控) — 本文件 mantra 心境，那个触发判定
+ - `superpowers-gate.md` (always_on 门控) — 本文件是**心境**先行（内化哲学），那个是**判定**在后（流程触发）。always_on 顺序：mantra 内化 → gate 判定 → workflow 落地
```

### 改动 2 · `.windsurf/rules/superpowers-gate.md`

**2a · 在文件顶部说明位置加「与 dao-mantra 的关系」段**

位置：当前 L7-L8 引言后插入新段，在 L10「与 Windsurf Plan Mode 的边界」之前。

```markdown
## 与 dao-mantra 的关系（先读心境再走判定）

`dao-mantra.md` 与本文件都 always_on，加载顺序认知如下：

1. **mantra 先**：内化心怀八句（道法自然 / 慎终如始 / 太上不知有之 等）作为底层心境
2. **gate 后**：本文件按显式信号 + 复杂度信号判定是否走 superpowers 五步
3. **workflow 落地**：触发后由 `/dao-superpowers` workflow 实施

无心境裸走仪式 = 形似神离。本 gate 判定 yes 才动用 workflow，但 mantra 永远在场。
```

**2b · 「显式触发后的强制流程」段头加 workflow 互引**

位置：当前 L43。

```diff
## 显式触发后的强制流程（缺一为流程缺陷）

+ > 五步落地实现见 `/dao-superpowers` workflow；心怀根基见 `dao-mantra.md`。
+
> **skill 名双列**：obra superpowers 是架构概念标准名；dao-* 是本环境实际可加载的 skill 名。
```

**2c · 「反模式」表加一行**

位置：当前 L82-L90 反模式表末尾。

```diff
| 直推 master | finishing-a-branch 跳过 | merge / PR 二选一，仪式必须 |
+ | 离心境裸走仪式 | 机械走五步无神，反模式叠加 | 先内化 dao-mantra 八句心怀，再走 gate 判定，无心境的仪式是形似 |
```

## 验证

1. 两文件 grep 互相文件名命中 ≥1 次：
   - `grep "superpowers-gate" .windsurf/rules/dao-mantra.md` → ≥1
   - `grep "dao-mantra" .windsurf/rules/superpowers-gate.md` → ≥2
2. dao-mantra.md 行数 ≤45（场景表 + 协同段微增）
3. superpowers-gate.md 反模式表多 1 行
4. `/dao-superpowers` workflow 在两文件均可被找到

## 风险

- **低风险**：两文件都是规则文档，改动是文字增补，无逻辑改动
- **零回归**：现有触发判定逻辑不变，只是增加跨引

## 不做的事

- 不重写两文件结构
- 不改触发判定阈值（≥3 文件 / ≥100 LOC 等）
- 不改 mantra 八句根基内容
- 不改 superpowers-gate 反模式表已有 6 行（只新增 1 行）

## 完工标准

1. ✅ 两文件互相 reference 命中验证通过
2. ✅ dao-meta 三关过审（通用性 / 边界 / 影响）
3. ✅ commit + merge 回 master + cleanup worktree
