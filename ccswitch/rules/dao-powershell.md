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

- **Windows PowerShell 假错**：用 `$LASTEXITCODE`（`Start-Process -PassThru` 那条路则用 `$proc.ExitCode`）判成败，不看输出有无 "error" 字样；中文「所在位置 行:X」是 ErrorRecord 非真错；禁 `2>&1`（混流致假错），噪音用 `2>$null`。**`2>&1` 具体怎么害人**：它把 native 命令的 stderr 包成 `NativeCommandError`，在 `$ErrorActionPreference='Stop'` 下把**正常的 stderr 进度行**（如 cargo 的 Locking/Updating）判成终止性错误、中断整个脚本；要捕获输出就用 `Start-Process -RedirectStandardOutput/-RedirectStandardError` 落真实文件。完整判据与出处：`ccswitch/rules/dao-officer-clauses.md` 通用节同名条款
- **禁改含中文/无 BOM 文件 —— 真凶是 `Get-Content` 本身，不是那条管道**（2026-08-02 射程订正）：本条原写作「**PS 管道**禁改含中文/无 BOM 文件」，于是两起真实事故从它的字面射程外溜了过去——两起的写侧都规范（`[IO.File]::WriteAllText` + 无 BOM UTF8），毁在读侧。判据是：**PS5.1 的 `Get-Content` 任何形态**（含 `-Raw`、含只读不写）读无 BOM UTF-8 时按本机 ANSI 代码页解码，**内容当场就毁了**，写侧再规范也救不回来；`Set-Content -Encoding utf8` 另会写出带 BOM 的文件、弄坏 JSON/TOML 消费方。文件内容替换一律用编辑工具，非用不可时读侧走 `[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)`。**连带一个静默失败**：字符串已成乱码后，后续 `-replace '<含中文的模式>'` 一律不命中且不报错、`$LASTEXITCODE` 照样 0。三起实证、逐字复现步骤与占位符没被替换那次的下场：`ccswitch/rules/dao-officer-clauses.md` 通用节「编码铁律」（2026-07-12 Cargo.toml/JSON 中招致 tauri dev 崩那次仍是本条最早的出处）
- **禁 PowerShell 里的 Bash heredoc**：`python - <<'PY'` 在 PS 中报 ParserError，改用 here-string + `Set-Content`
- **Inline 长命令**：PS 处理 `node -e "..."` >300 字符或含嵌套引号会被 PSReadLine 截断 → 写脚本文件再跑

---

## 射程边界（照直写，别读成全包）

**触发器是「Read 一个已存在的 `.ps1`」**，所以它覆盖**改**、不覆盖**从零新建**——
新建一个 `.ps1` 而全程没 Read 过任何 `.ps1` 时，这四条一条都不会被送到眼前。
这就是 dao.md Shell 节仍保留一行存根指针的理由：存根是那半的唯一兜底，而它是纯文字、靠记性。
**两半都不完整，合起来也不是 100%**——别把「有了作用域规则」读成「这四条现在有人管了」。
