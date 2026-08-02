# 查文档走哪条路 · 细则正文（dao.md Shell 节存根的展开面）

> **必经动作**：**要查任何库 / 框架 / SDK / API / CLI 工具的文档之前 = 先看下面那张表**。
> 触发时刻很具体——你正准备开 WebFetch 或 WebSearch 去查"某个东西怎么用"。

## 一句话：为什么要有这张表

**今天有一个域名连不上，而好几个官各自花时间去绕它，绕出了三种不同的走法。**
一个官摸索出来的路，传不到下一个官那里——同级 agent 之间没有横向通道。
所以把"该走哪条"写在这里一次，谁要查文档谁先看这张表，不用再各自摸索。

**顺带纠正一个最容易犯的误判**：连不上的是**一个域名**，不是"网络受限"。
普通网页照样能取。把它读成后者，会让人放弃一整类本来好用的办法。

## 分层：按你要查什么选路

| 你要查什么 | 走哪条 | 为什么 |
|---|---|---|
| **库 / 框架 / SDK / API / CLI 的文档**（React、Tauri、Anthropic SDK、某个 npm 包……） | **context7 优先** | **这条一直就在，只是没人看见**：context7 自己的 MCP server instructions 原文就写着「凡用户问到库、框架、SDK、API、CLI、云服务，用本 server 取当前文档，**优先于网页搜索**；哪怕你觉得自己知道答案也用——你的训练数据可能没跟上」。它每个会话都注入，**不是本档新引入的方案，本档只是把它搬到看得见的地方**。 |
| **普通网页**（博客、GitHub、RFC、任意站点） | **WebFetch** | 实测正常，没有问题。 |
| **Claude Code / Claude API 自己的官方文档** | 见下面「特例」 | 官方文档站本机取不到，但有两条免费替代，都实测有效。 |
| 以上都取不到 | 见下面「Firecrawl 的位置」 | **默认不用**；要用先过那一节的三样自检。 |

## 特例：`code.claude.com` 本机取不到

**这是本机环境事实，不是官方站挂了**——别写成"官方文档下线了"去误导别人。

两条替代，都免费、都实测可达，**任选其一**：

1. **context7 的 `/websites/code_claude`** —— 每条结果带原始出处 URL，可回溯。
2. **GitHub 镜像仓 `pleaseai/claude-code-docs`** —— 用 `gh api` 直接取，见下面折叠段里的取法。

### 怎么复核它恢复了没有

跑一次 `WebFetch https://code.claude.com/docs/en/hooks`：**返回正文＝已恢复**（回来删掉本节特例）；
仍返回 `Socket is closed` ＝ 照旧走上面两条替代。

<details>
<summary>实测记录与镜像仓取法（技术细节，2026-08-02）</summary>

**三个域名实跑结果**：

| URL | 结果 |
|---|---|
| `https://code.claude.com/docs/en/hooks` | **Socket is closed**（当天累计 30 次失败） |
| `https://docs.anthropic.com/en/docs/claude-code/hooks`（旧址） | **301 Moved Permanently → `code.claude.com/docs/en/hooks`** |
| `gh api repos/pleaseai/claude-code-docs/...` | 正常（本档镜像仓那段就是这么跑通的） |
| 普通网页 WebFetch | 正常。**但不是全通**——同日 `firecrawl.dev/pricing` 超时、`raw.githubusercontent.com/firecrawl/...` socket hang up，见下面「已知不可达 / 取数受限清单」第 2、3 行 |

⚠️ **旧地址不是替代路径**：它 301 重定向到同一个取不到的主机上，绕不过去。
WebFetch 对跨主机重定向不自动跟随、会把目标 URL 交回给你——**那个交回来的 URL 正是取不到的那个**，
别照着它再发一次。

**镜像仓取法**（本档写作时实跑通过，`pleaseai/claude-code-docs`）：

```bash
# 列全部文档路径
gh api repos/pleaseai/claude-code-docs/git/trees/main?recursive=1 --jq '.tree[].path'
# 取某一篇（base64 解码后落文件，再用 Read/Grep 读）
gh api repos/pleaseai/claude-code-docs/contents/docs/hooks.md --jq '.content' | base64 -d > _tmp/hooks.md
```

该仓自述的同步机制：以官方 `llms.txt` 为真相源、约 6 小时同步一次，**下载失败即中止提交**
（刻意设计成宁可停更也不产生"假删除"）。**这是它的自述，本档没有独立验证过它的时效性**——
拿它当"当前文档"用时，涉及版本敏感的结论最好再对一次 context7。

**本档结论就是这么查出来的**：2026-08-02 判断「PreToolUse hook 与权限 deny 规则谁先跑」，
`code.claude.com` 取不到 ⇒ 走镜像仓 `docs/permissions.md`，拿到原文
"PreToolUse hooks run before the permission prompt" 与 "Hook decisions don't bypass permission rules"，
再用一条本机命令实跑验证（同时命中 deny 规则与一道 hook，收到的是 hook 的消息）⇒ 结论坐实。

</details>

## Firecrawl 的位置：默认不用，按需呈批

**它解什么**：本机够不着的任意网页——它走自己的服务器抓取，能力是真的。

**它的定位与 dao 里「Workflow 是重器，须用户明示授权」同构**：

| 态 | 行为 |
|---|---|
| **默认** | **不用**。WebFetch / context7 / GitHub 镜像 三条免费路打底 |
| **用户主动说「用 Firecrawl」** | **直接用，不再问** |
| **AI 判断这次值得用** | **呈用户拍板**，说清「试过哪几条、缺什么精度、这次预估抓多少页」 |

### 🔴 防滑判据：什么时候**才准**开口提它

**只有当上面三条免费路都实际试过、且拿不到所需精度时，才可以提。**
提的时候**必带三样**——**①试过什么**（哪几条路、各自失败形态）**②缺什么精度**（摘要答不上哪个具体问题）
**③这次预估抓多少页**。**三样答不出就不许提。**

**为什么专门立这一条**：不设它，「强烈推荐」会退化成「每次都推荐」，
而那等于**把默认态偷偷改回去**——默认是"不用"，一个每次都出现的建议会让"不用"名存实亡。

### 成本这件事为什么不由 AI 拍

**用户的实际用量是一个月几千次调研级抓取**。在那个量级上，免费层 1000 credits/月**根本不成立**，
Standard 档 **$83/月起步**。
⚠️ **这个数字是 2026-08-02 才拿到的，而在此之前本档作者按「一个月 10 次大调研」估过一次——差一个数量级。**
留着这句当判据：**成本类判断默认呈用户**，AI 手里通常没有用量这一半的事实，而估错的方向是系统性的（往小里估）。

### 当前接入状态

**尚未接入**（用户 2026-08-02 拍板：不主动接，按需再说）。
接入材料已备：`_tmp/firecrawl-mcp/ADD-FIRECRAWL.md`。

## 要加任何 MCP 之前：先认清源与投影

**MCP 的真相源是 cc-switch DB 的 `mcp_servers` 表，`~/.claude.json` 只是投影。**

⇒ **`claude mcp add` 写的是投影**：当场生效，但**下次下发即被整体覆盖，且无告警**。
照它做会得到"我明明加过了，怎么没了"，而中间没有任何一步报错。

正路：**改 DB**（属用户动作——AI 侧写 cc-switch DB 被权限分类器全路径拦截，
这是「AI 不得改自己的工具面」的意图级保护）。

这是 dao.md「改配置先认源与投影」那条链的**又一个面**（前两个面是 hooks 注册与 settings），
2026-08-02 首次在 MCP 面实测确认。**认源的动作是「追下发链」，不是「找长得像源的文件」。**

## 已知不可达 / 取数受限清单

**它不是任何东西的触发器**（原先挂在这里的「撞满 3 个就引入 Firecrawl」计数已于 2026-08-02
作废——引入与否按上面的按需呈批走，不由计数触发）。
它存在的唯一理由是**让这个面的增长可见**：一次失败像偶发，三次并排摆着才看得出是不是趋势。
撞到一个记一行。

| # | 目标 | 首次撞上 | 失败形态 | 有替代吗 |
|---|---|---|---|---|
| 1 | `code.claude.com/docs/*` | 2026-08-02 | WebFetch `Socket is closed`（当天 30 次） | **有两条**：context7 `/websites/code_claude`、镜像仓 `pleaseai/claude-code-docs` |
| 2 | `firecrawl.dev/pricing` | 2026-08-02 | WebFetch **超时** | 部分——WebSearch 摘要拿到档位价，但**没答上「API key 怎么配」与「能不能自托管」两问** |
| 3 | `raw.githubusercontent.com/firecrawl/...` | 2026-08-02 | WebFetch **socket hang up** | 同上 |

⚠️ **第 3 行别读成「raw.githubusercontent.com 整个不可用」**：同日经 **`gh api`** 取
`pleaseai/claude-code-docs` 正常（本档上面那段镜像仓取法就是这么跑通的）。
**同一个主机，`gh api` 这条路通、WebFetch 那条路不通** ⇒ 记的是**「目标 + 取数方式」这一对**，
不是主机本身。换条路再试一次，比断言"这个站挂了"便宜得多。

⚠️ **第 2、3 行合起来说明失败面已不止一个域名了**——但**这仍然不构成引入 Firecrawl 的理由**
（用户已拍板按需）。把"面在变大"和"所以该买"分开，是这张表存在的意义。

## 投递面：照直写

**这份档没有机器触发器。**

- 上面那张表里**只有第一行是有投递的**：context7 的"优先用我"那句话由它自己的 MCP server
  instructions 每个会话注入，**不依赖本档**（本档的作用是让人知道那句话存在、并把它跟其余几层连起来）。
- **`code.claude.com` 特例与 Firecrawl 记账这两节，只有 dao.md Shell 节那一行存根在指着**，
  没有任何 hook、没有任何 `paths:` 作用域档会在"你正要查文档"那一刻把它送到眼前——
  **因为那一刻不 Read 任何文件，构造不出路径锚点**。给它编一个等于造一个永不触发的档。
- 所以它的实际强度是**纯文字兜底**。别把"写下来了"读成"从此有人管了"。

已想过、判为不该做的两条：①给 WebFetch 加 PreToolUse hook 拦 `code.claude.com` —— 那要改 hook
注册（用户动作），且一个域名的临时故障不值得一道常驻闸；②把表塞进 dao.md 正文 —— always-on
每轮注入的额度只该付给"每轮都要用"的东西，查文档不是每轮都做。
