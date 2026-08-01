# PowerShell 脚本坑 · 细则正文（dao.md Shell 节存根的展开面）

> **必经动作**：**新建或改动任何 `*.ps1` 之前 = Read 本文件全文**。
> 与 `dao-dispatch.md` / `dao-longwindow.md` / `dao-guard-writing.md` 同型存根化——
> always-on 每轮注入的配额只该付给「每轮都要用」的东西，而下面四条**只在「我正要写/改一个 PowerShell 脚本」那一刻**用得上。
>
> **本文件与那三个存根的差别：它装了机器触发器。** 用户级 `~/.claude/rules/dao-scope-powershell.md`
> 带 `paths: ["**/*.ps1", ...]`，Read 任何 `.ps1` 时宿主自动把「去读本文件」这句话送到眼前——
> 那三个存根的「必经动作」四个字至今**只靠记性**（本仓实测无标记时刻的自由裁量携带率 9-24%）。
> 部署与漂移自检见 `ccswitch/scripts/dao-rules-deploy.mjs`。

> **刻意不迁进本文件、留在 dao.md Shell 节的**（它们不是「写 PS 脚本那一刻」专属）：
> **路径锚点**（`git -C` / `pnpm --dir`，跨 workspace 通用，不限 PS）· **验证加 marker**
> （触发时刻是「跑一条关键验证」不是「改脚本」）· **串行敏感验证** · **临时文件归项目**
> （每轮都要用）· **截图路径强制** · **settings.json 门禁** · **改配置先认源与投影**
> （后两条虽有文件锚点，但属交互门禁/高频判据，按「拿不准不迁」留置）。

---

- **Windows PowerShell 假错**：用 `$LASTEXITCODE` 判成败，不看输出有无 "error" 字样；中文「所在位置 行:X」是 ErrorRecord 非真错；禁 `2>&1`（混流致假错），噪音用 `2>$null`
- **PS 管道禁改含中文/无 BOM 文件**：PS5.1 `Get-Content` 对无 BOM UTF-8 按 ANSI 读、`Set-Content -Encoding utf8` 写出带 BOM——管道改写会把中文变乱码且 BOM 弄坏 JSON/TOML 消费方。文件内容替换一律用编辑工具（2026-07-12 实证：Cargo.toml/JSON 中招致 tauri dev 崩）
- **禁 PowerShell 里的 Bash heredoc**：`python - <<'PY'` 在 PS 中报 ParserError，改用 here-string + `Set-Content`
- **Inline 长命令**：PS 处理 `node -e "..."` >300 字符或含嵌套引号会被 PSReadLine 截断 → 写脚本文件再跑

---

## 射程边界（照直写，别读成全包）

**触发器是「Read 一个已存在的 `.ps1`」**，所以它覆盖**改**、不覆盖**从零新建**——
新建一个 `.ps1` 而全程没 Read 过任何 `.ps1` 时，这四条一条都不会被送到眼前。
这就是 dao.md Shell 节仍保留一行存根指针的理由：存根是那半的唯一兜底，而它是纯文字、靠记性。
**两半都不完整，合起来也不是 100%**——别把「有了作用域规则」读成「这四条现在有人管了」。
