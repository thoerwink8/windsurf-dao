# OD 面板同步 · design/ → Open Design 项目工作目录

> 天地，万物之盗；万物，人之盗。三盗既宜，三才既安。
> 设计稿活在代码仓，OD 面板只认真实文件——robocopy 做信使，快照即桥梁。

## 背景

Open Design 右侧「设计文件」面板的文件扫描器不跟随 junction / 符号链接，只显示项目工作目录里的真实文件。要让代码仓的 `design/` 设计稿出现在 OD 面板，唯一办法是把文件真实复制进 OD 项目的工作目录。

这是**快照副本**——代码仓改动后会漂移，需要重新同步。

与 `sync.md`（设计↔代码漂移同步）是两回事，互不干涉。

---

## §1 · 解析目标 OD 项目 ID

按以下优先级取得 `odProjectId`：

1. **命令参数**：`/dao-design od-sync <od-project-id>` 直接给出
2. **项目配置文件**：读 `design/.od-sync.json`，取 `odProjectId` 字段
3. **交互询问**：上述都没有 → AskUserQuestion 让用户输入，并提示可写入配置免得每次问

### design/.od-sync.json 示例

```json
{
  "odProjectId": "6b666545-f3d0-4b79-8fa6-356f17db3ce4",
  "targetSubdir": "TraceyU-design"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `odProjectId` | 是 | OD 项目 UUID |
| `targetSubdir` | 否 | OD 工作目录下的子目录名，默认 `design` |

取到 `odProjectId` 后，首次同步前用 `Test-Path` 校验目标目录存在：

```
C:\Users\Administrator\AppData\Roaming\Open Design\namespaces\release-stable-win\data\projects\<odProjectId>\
```

不存在 → 报错并提示用户核对 ID，不盲目创建。

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
  - 代码仓 design/ 再有改动，需重跑 /dao-design od-sync
```

若用户未配置 `design/.od-sync.json`，追加：

```
💡 可将 OD 项目 ID 写入 design/.od-sync.json 免得每次输入：
  {"odProjectId": "<id>", "targetSubdir": "<subdir>"}
```

---

## §5 · 反模式

1. **用 symlink/junction 代替 robocopy** — OD 面板不跟随链接，这是做此 skill 的原因
2. **同步时不排除 *.artifact.json** — 会覆盖 OD 自己的元数据
3. **看 robocopy 输出文字判成败** — 违反 dao Shell 假错规则，必须用 $LASTEXITCODE
4. **自动创建不存在的 OD 项目目录** — 目录不存在说明 ID 错了，不应盲建
5. **与 sync.md 混用** — sync.md 是设计↔代码漂移同步，本文件是复制到 OD 面板，职责不同
