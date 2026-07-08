# OD 面板同步 · design/ → Open Design 项目工作目录

> 天地，万物之盗；万物，人之盗。三盗既宜，三才既安。
> 设计稿活在代码仓，OD 面板只认真实文件——robocopy 做信使，快照即桥梁。

## 背景

Open Design 右侧「设计文件」面板的文件扫描器不跟随 junction / 符号链接，只显示项目工作目录里的真实文件。要让代码仓的 `design/` 设计稿出现在 OD 面板，唯一办法是把文件真实复制进 OD 项目的工作目录。

这是**快照副本**——代码仓改动后会漂移，需要重新同步。

**自动触发（2026-07-08 起，用户无感）**：本 skill 的 §3 增量同步不再依赖用户手动调用——
凡本轮改动含 `design/**` 且项目存在 `design/.od-sync.json`，dao.md 设计同步门控（步骤 4）
在声明完成前自动执行一次；升格流程另有 asset.md §B.5.6 显式兜底。手动 `/dao-design od-sync`
保留为兜底入口（如门控被跳过的只读会话后补同步）。曾因纯靠人记，OD 端静默滞后一周。

> ✅ **裁决已定（2026-07-08 实机验证，#29 收口）**：OD 项目 metadata 可配置 `linkedDirs`
> 直挂代码仓目录，但实测证实——**该字段不影响「设计文件」面板的文件列表**。已配置
> `linkedDirs: ["D:\\...\\<repo>"]` 的真实项目，面板内页面清单仍停留在最后一次 robocopy
> 同步的时间点（实测冻结 1 周，且缺失同步窗口内新增的正式稿），并非仓库实时状态。
> **结论：robocopy 快照管线不过时，继续作为唯一同步机制**；linkedDirs 字段目前作用未知
> （可能服务其他尚未验证的功能），与本管线无关，不再是"待裁决"。

与 `sync.md`（设计↔代码漂移同步）是两回事，互不干涉。

---

## §1 · 解析目标 OD 项目 ID

按以下优先级取得 `odProjectId`（**用户不需要知道 UUID 的存在**）：

1. **项目配置文件**：读 `design/.od-sync.json`，取 `odProjectId` 字段。有则直接用，跳过后续步骤
2. **命令参数**：`/dao-design od-sync <od-project-id>` 显式给出（高级用法）
3. **自动发现**：上述都没有 → 查询 OD 本地数据库，列出项目名让用户选

### §1.1 · 自动发现流程（首选路径）

OD 的项目元数据存在 SQLite 数据库中：

```
$env:APPDATA\Open Design\namespaces\release-stable-win\data\app.sqlite
```

查询项目列表：

```powershell
$odDb = "$env:APPDATA\Open Design\namespaces\release-stable-win\data\app.sqlite"
$projects = sqlite3 $odDb "SELECT id, name FROM projects;"
```

每行格式 `<uuid>|<项目名>`。解析后用 AskUserQuestion 呈现项目名列表让用户选——**用户看到的是项目名，不是 UUID**。

选定后自动：
1. 写入 `design/.od-sync.json`（下次直接走优先级 1，不再问）
2. 继续执行 §2 → §3 同步

**数据库不存在或查询失败** → 降级为 AskUserQuestion 让用户手动输入 UUID，并提示去 OD 数据目录查看。

### §1.2 · design/.od-sync.json 格式

```json
{
  "odProjectId": "6b666545-f3d0-4b79-8fa6-356f17db3ce4",
  "targetSubdir": "TraceyU-design"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `odProjectId` | 是 | OD 项目 UUID（自动发现会自动填入） |
| `targetSubdir` | 否 | OD 工作目录下的子目录名，默认 `design` |

取到 `odProjectId` 后，首次同步前用 `Test-Path` 校验目标目录存在：

```
$env:APPDATA\Open Design\namespaces\release-stable-win\data\projects\<odProjectId>\
```

不存在 → 报错并提示用户核对，不盲目创建。

---

## §2 · 锚定项目根

用 `git -C` 或 `--prefix` 锚定项目根，不依赖 cwd（dao Shell 路径锚点规则）：

```powershell
$projectRoot = git rev-parse --show-toplevel
```

源目录：`$projectRoot\design`

若 `design/` 不存在 → 报错并提示：项目无 design/ 目录，无法同步。

---

## §3 · 执行同步

### §3.1 · 默认模式（增量，不删除）

```powershell
$odBase = "$env:APPDATA\Open Design\namespaces\release-stable-win\data\projects"
$targetDir = "$odBase\<odProjectId>\<targetSubdir>"

robocopy "$projectRoot\design" $targetDir /E /XF *.artifact.json
```

- `/E`：复制子目录（含空目录）
- `/XF *.artifact.json`：排除 OD 产物文件（避免覆盖 OD 自己的元数据）
- 增量模式：只新增/更新，不删除 OD 端多出的文件

### §3.2 · 镜像模式（完全同步，含删除）

用户显式要求"完全镜像"或传参 `--mirror` 时：

```powershell
robocopy "$projectRoot\design" $targetDir /MIR /XF *.artifact.json
```

- `/MIR`：完全镜像，OD 端多出的文件会被删除
- 执行前用 AskUserQuestion 确认：「镜像模式会删除 OD 端多出的文件，确认？」

### §3.3 · 退出码判断

robocopy 退出码语义特殊，**用 `$LASTEXITCODE` 判，不看输出文字**（dao Shell 假错规则）：

| 退出码 | 含义 | 判定 |
|---|---|---|
| 0 | 无变化 | 成功 |
| 1 | 有文件复制 | 成功 |
| 2 | 有多余文件（仅 /MIR 时出现） | 成功 |
| 3 | 1+2 | 成功 |
| 4-7 | 有不匹配/额外文件 | 成功 |
| ≥8 | 有失败 | 失败 |

```powershell
if ($LASTEXITCODE -ge 8) {
    # 真失败
} else {
    # 成功（含 0=无变化、1=有复制等）
}
```

---

## §4 · 同步后提示

同步成功后输出：

```
✅ design/ 已同步到 OD 面板

  源：{projectRoot}\design
  目标：{targetDir}
  模式：增量（/E） 或 镜像（/MIR）

⚠ 这是快照副本：
  - 在 OD 面板按 F5 或重新打开项目即可看到更新
  - 代码仓 design/ 后续改动会由设计同步门控自动附带刷新（见下方「自动触发」），手动 /dao-design od-sync 仅作兜底
```

若用户未配置 `design/.od-sync.json`，追加：

```
💡 可将 OD 项目 ID 写入 design/.od-sync.json 免得每次输入：
  {"odProjectId": "<id>", "targetSubdir": "<subdir>"}
```

---

## §5 · 回搬（od-pull：OD 工作目录 → 代码仓 design/）

> 反者道之动。OD 侧改了快照副本（用户在 OD 面板里让 AI 直接编辑文件）时，改动困在
> OD 工作目录里——此前回搬纯手动，是断链点。

用户说「od-pull」「把 OD 里的改动搬回来」时：

1. **解析路径**：同 §1 取 `odProjectId` 与 `targetSubdir`，得 `$targetDir`
2. **冲突检测（先看后搬，不盲覆盖）**：

   ```powershell
   robocopy $targetDir "$projectRoot\design" /E /L /XF *.artifact.json /XO /NDL /NJH /NJS
   ```

   `/L` 只列不拷，`/XO` 排除旧文件——输出即「OD 端较新、将覆盖代码仓」的文件清单。
   逐文件核对：代码仓侧该文件在 git 里有未提交改动（`git status --short design/<file>`）
   → **冲突**，列给用户裁决（AskUserQuestion：以 OD 为准 / 以代码仓为准 / 逐个看 diff）；
   干净文件直接进入下一步
3. **执行回搬**（仅无冲突或用户已裁决后）：

   ```powershell
   robocopy $targetDir "$projectRoot\design" /E /XF *.artifact.json /XO
   ```

   `/XO` 保证只搬 OD 端更新的文件，不用旧快照倒灌覆盖代码仓的新改动
4. **回搬后**：`git status design/` 展示改动清单让用户确认；改动含 workspace 草稿时提示走 `asset.md` §B 升格流程

**artifact.json 孤儿清理**：`*.artifact.json` 是 OD 的产物元数据，双向都排除（§3 已排除出向）。
回搬时若发现 OD 端存在**无对应 HTML** 的孤儿 artifact.json（HTML 已删/改名），提示用户可在
OD 端删除，不自动删（OD 自己的数据 OD 做主）。

---

## §6 · 反模式

1. **用 symlink/junction 代替 robocopy** — OD 面板不跟随链接，这是做此 skill 的原因
2. **同步时不排除 *.artifact.json** — 会覆盖 OD 自己的元数据
3. **看 robocopy 输出文字判成败** — 违反 dao Shell 假错规则，必须用 $LASTEXITCODE
4. **自动创建不存在的 OD 项目目录** — 目录不存在说明 ID 错了，不应盲建
5. **与 sync.md 混用** — sync.md 是设计↔代码漂移同步，本文件是复制到 OD 面板，职责不同
