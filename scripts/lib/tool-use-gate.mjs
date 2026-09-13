// scripts/lib/tool-use-gate.mjs —— Bash 命令文本上的几条确定性判据。
//
// 改这段代码前必须知道的六条：
//
// 1. 判据早就有了，缺的是触发。memory `heredoc-eats-backslash-escapes` 和
//    `python-stub-use-py` 每轮只注入索引行，具体内容要主动 recall——2026-09-05
//    一轮对话里两条被踩三次，每次都是「我有这条却又踩了」。本模块只负责看命令
//    文本给不给注，怎么触发在 host/skills/tool-use-gate/hooks/。
//
// 2. **永不拦**。命中只注一句，不命中就闭嘴。拦错了会挡住正常工作，而这几条
//    本来就有误报面（不是每个 heredoc 都含转义）。与 ask-gate 同口径。
//
// 3. 机器只看命令文本，不理解意图。heredoc 三条（有 heredoc、目标是 js/ts、
//    文本里有反斜杠转义）全到才注；python 只认命令词是 `python`/`python.exe`，
//    `py` 和 `python3` 不注。
//
// 4. 本文件是纯函数，不碰文件系统、不 spawn。hook 入口才读 stdin。谁要在这
//    里加 spawn，必须带 windowsHide: true（判例 platform-adapter-deleted-while-still-used：
//    每轮闪窗）。
//
// 5. 与同日 ask-gate 同型不同事，不是第二层补丁。那边挂提问工具，这边挂 Bash。
//
// 6. 每条判据的**判据轴是行为，不是工具名**（2026-09-10 定的调子）：换工具名不该
//    漏判，所以 `readsCredentialStore` 认的是「命令文本指向凭据库」，不区分
//    cat / jq / node -e / python3。加新判据时照这条走。

export const BASH_TOOLS = ['Bash'];

export const HEREDOC_NOTE =
  '[工具使用闸] heredoc 写 .mjs/.js/.ts 时，shell 会吞掉 \\n \\s 这类转义（变成真换行/真字符）。改用 Edit 工具，或把内容写成 raw 文件再 splice。';

export const SHELL_ESCAPE_NOTE =
  '[工具使用闸] 这条命令要把含转义的文本经 shell 落进文件（重定向/heredoc/sed -i/tee/python -c 都算）。'
  + '每多一层中转就多一次转义，而失败是静默的：命令退出 0、文件也写出来了，错误要等很久以后才以别的面目炸。'
  + '改用 Write/Edit 工具直接写，或把内容落成 raw 文件再用不含转义的小脚本读进来拼。';

export const PYTHON_NOTE =
  '[工具使用闸] 本机 `python` 是 WindowsApps stub，exit 49 静默失败，命令「成功」但一个字没写进去。用 `py`（或 `python3`）。';

export const SYSTEMD_NOTE =
  '[工具使用闸] 这是在 ssh 里手搓跑一个有 systemd unit 的脚本。unit 的 `Environment=` / `WorkingDirectory=` / `User=` '
  + '就是它的运行契约，手搓 shell 换了一份契约——测出来的失败不属于被测对象。'
  + '用 `systemctl start <unit>`（配 `--no-block`）触发它自己，再 `journalctl -u <unit>` 读结果。';

/** 从 Bash 工具入参取命令文本。字段名不靠猜：command 优先，没有才 cmd。 */
export function bashCommand(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  return '';
}

/**
 * 命令文本是否含 heredoc（`<<EOF` / `<<'EOF'` / `<<"EOF"` / `<<-EOF`）。
 * 只认有名字的定界符；`<<` 后面直接是重定向或空，不算。
 */
export function hasHeredoc(command) {
  // 定界符必须全大写或含 EOF/END/HERE 这类惯用名，避免把 `echo a << b` 当 heredoc。
  // 真 heredoc 几乎都是 EOF / END / PY / JS / JSON / FILE。
  return /<<\s*-?\s*(['"]?)(?:EOF|END|HERE|TXT|JSON|JS|TS|PY|XML|HTML|MD|SQL|YAML|YML|[A-Z][A-Z0-9_]*)\1(?:\s|$)/.test(String(command || ''));
}

/** 命令文本是否点到 .mjs / .js / .ts 目标（issue 点名的三种；.cjs 不在范围内）。 */
export function targetsJs(command) {
  return /\.(?:mjs|js|ts)\b/i.test(String(command || ''));
}

/**
 * 命令文本里是否有反斜杠转义（`\n` `\s` `\d` `\[` 之类）。
 * 认的是两个字符「\ + 字母/常用元字符」，不是真换行——真换行是 heredoc 体，不算吞转义。
 */
export function hasBackslashEscape(command) {
  return /\\[nrtwsdWDSB\[\](){}.*+?^$|0]/.test(String(command || ''));
}

export function isHeredocEscape(command) {
  const cmd = String(command || '');
  return hasHeredoc(cmd) && targetsJs(cmd) && hasBackslashEscape(cmd);
}

/**
 * 命令要把文本**写进文件**吗（重定向 / heredoc / tee / 就地改）。
 *
 * 这是新判据轴的第一条：不看用哪个工具，看**行为**——「文本正在经 shell 落进文件」。
 * 旧判据只认 heredoc，于是 python3 heredoc / sed -i / perl -i / tee 全是盲区
 * （2026-09-10 实测四个形态 classifyBash 都返回空，而那晚的正则正是经 python3 heredoc 变形的）。
 */
export function writesToFile(command) {
  const cmd = String(command || '');
  if (hasHeredoc(cmd)) return true;
  // `> file` / `>> file`。**排除 fd 重定向**（2>&1、&>）与数字比较（x=1>2）；
  // 别把前面的空格排掉——`echo hi > a.mjs` 的 `>` 前面正是空格，第一版把它排了，
  // 于是最常见的那种重定向反而漏判（2026-09-10 实测）。
  if (/(?:[0-9]?>>?)(?!&)\s*[^\s&|;]+/.test(cmd) && !/\d>&\d/.test(cmd)) return true;
  if (/\b(?:tee|sponge)\b/.test(cmd)) return true;
  // 就地编辑：`sed -i` / `sed -i.bak` / `perl -pi` / `perl -i -pe`。
  // 注意 perl 的合并写法 `-pi`（不是 `-p -i`）——第一版要求 `-i` 前是空白，漏了它。
  // 判据放宽成「短选项串里含 i」：`-[a-zA-Z]*i`。
  if (/\b(?:sed|perl)\b[^|;]*\s-[a-zA-Z]*i[a-zA-Z]*(?:\.\S+)?\b/.test(cmd)) return true;
  // 解释器一行式里显式调用写文件的 API：`node -e "fs.writeFileSync(...)"`。
  // 只看「解释器 + -c/-e」不够（那样会把只读的一行式也命中），必须同时有写入调用。
  if (/\b(?:python3?|py|node|ruby|php|deno|bun)\b[^|;]*\s-(?:c|e)\b/.test(cmd)
      && /(?:writeFileSync|writeFile|appendFileSync|appendFile|fopen\s*\(|open\s*\([^)]*['"][wa]|\bwrite\s*\()/.test(cmd)) return true;
  return false;
}

/**
 * 命令里有没有**代码/配置文本**（写文件的目标或内容）。
 * 认扩展名，也认「文本里明显是代码」的形态——目的是覆盖「换了个目标文件类型」的下一次。
 */
export function touchesCodeText(command) {
  const cmd = String(command || '');
  if (/\.(?:[mc]?js|ts|tsx|json|jsonc|sh|bash|zsh|toml|ya?ml|py)\b/i.test(cmd)) return true;
  // 内容本身是代码的形态：`import ... from`、`export function`、`require(`、`=>`、正则字面量
  if (/\b(?:import|export|require)\s*[\(\s]/.test(cmd)) return true;
  if (/\/\^?[^/\n]*\\[nswdWDSB]/.test(cmd)) return true;             // 命令里含正则字面量的转义
  return false;
}

/**
 * 根治版判据（2026-09-10 用户指名要的「永久根治」）。
 *
 * 病根不是某一种工具，是「**代码/正则经 shell 文本层中转**」这个做法：每多一层
 * （bash → heredoc → python → 文件）就多一次转义，真值在传递中无声变形，而失败是
 * **静默的**——命令退出 0、文件也写出来了，错误要等很久以后以完全不相干的面目炸出来。
 *
 * 判据轴换成了行为，与工具名无关：**要写文件 + 含转义 + 碰的是代码/配置文本**。
 * 这样下次换个工具（python3 → perl → node -e → 别的）照样命中——旧判据认名字，
 * 名字一换就漏，实测漏了整整四个形态。
 *
 * 与既有 `isHeredocEscape` 的关系：旧判据是这条的**特例**（heredoc 是 writesToFile 的一种），
 * 两条都留着——旧的留着是因为它的文案更具体（点明 heredoc 这个坑），新的负责兜住其余形态。
 */
export function isShellEscapeIntoFile(command) {
  const cmd = String(command || '');
  return writesToFile(cmd) && hasBackslashEscape(cmd) && touchesCodeText(cmd);
}

/**
 * 命令词是不是裸 `python` / `python.exe`。
 * 按管道/列表拆段再看第一词：`py`、`python3`、`python3.12`、`/usr/bin/python3` 都不注；
 * `python -c`、`python.exe`、`/usr/bin/python`、`C:\WindowsApps\python.exe` 要注。
 * `echo python` 这种把 python 当参数的，不注。
 */
/**
 * 按管道/列表分隔符切段，**但不切引号里的**。
 *
 * 2026-09-05 本闸上线当天就误报了一次：`grep -nE "heredoc|python|systemd" 文件`
 * 被按 `|` 切成三段，第二段成了裸 `python` → 注一句「python 是 stub」。
 * 那条命令根本没调 python。误报多了闸就没人看，所以引号必须认。
 */
export function splitCommandSegments(command) {
  const s = String(command || '');
  const out = [];
  let cur = '';
  let quote = null;   // 当前处在哪种引号里：' 或 " 或 null
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') { cur += c + (s[++i] || ''); continue; }  // 双引号里 \ 转义下一个字符
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '&' && s[i + 1] === '&') { out.push(cur); cur = ''; i++; continue; }
    if (c === '|' && s[i + 1] === '|') { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function isPythonStub(command) {
  const parts = splitCommandSegments(command);
  for (const raw of parts) {
    let tok = String(raw || '').trim();
    if (!tok) continue;
    tok = tok.replace(/^(?:sudo|command|time|env)(?:\s+-[^\s]+)*\s+/, '');
    const cmd0 = (tok.split(/\s+/)[0] || '').replace(/^["']|["']$/g, '');
    const base = cmd0.split(/[/\\]/).pop() || '';
    if (/^python(?:\.exe)?$/i.test(base)) return true;
  }
  return false;
}

/**
 * 纯判定。返回按稳定顺序排列的命中项（heredoc 在前，python 在后）。
 * 空数组 = 不注。调用方不要把空数组和「没查成」混成一种输出。
 */
/**
 * 是不是「在 ssh 里手搓跑一个本该由 systemd 触发的脚本」。
 *
 * 三条全到才注：命令里有 ssh、跑的是 `node .../scripts/<x>.mjs`、而 `unitScripts` 里有同名脚本。
 * unitScripts 由调用方从 `host/machine/systemd/*.service` 的 ExecStart 里扫出来传进来
 * ——本模块是纯函数，不读文件；也不硬编清单（手写清单会过期）。
 *
 * 判据来源见 memory `verify-systemd-via-systemctl`：2026-09-05 两次假失败，
 * 一次是 ssh 没 nohup 被杀，一次是 `bash -c` 非登录 shell 缺 PATH，
 * 两次表象都像「机制坏了」，第二次已经开始怀疑被测代码本身。
 */
export function isHandRolledSystemdRun(command, unitScripts) {
  const cmd = String(command || '');
  const names = Array.isArray(unitScripts) ? unitScripts : [];
  // 没扫到样本 = 没查成，不注（不能当「没问题」）。
  // 注意：这行是**意图声明，不是闸**——名单为空时下面 includes 本来就永不匹配，
  // 摘掉它行为不变、测试照样绿（2026-09-05 变异测试实测）。留着是给改这段的人看的：
  // 若将来判据从 includes 换成别的（比如前缀匹配、正则），这行就变成承重的了，别顺手删。
  if (names.length === 0) return false;
  // ssh 必须是**命令词**，不能全文匹配 /\bssh\b/：写一段含 "ssh ..." 字符串的测试代码时
  // 全文匹配会命中，而那条命令根本没连服务器。与 python 那条同一类误报，同一个治法。
  const segs = splitCommandSegments(cmd);
  const sshSeg = segs.find((raw) => {
    const tok = String(raw || '').trim().replace(/^(?:sudo|command|time|env)(?:\s+-[^\s]+)*\s+/, '');
    const base = ((tok.split(/\s+/)[0] || '').replace(/^["']|["']$/g, '').split(/[/\\]/).pop() || '');
    return /^ssh(?:\.exe)?$/i.test(base);
  });
  if (!sshSeg) return false;
  for (const m of sshSeg.matchAll(/node\s+(?:[^\s;|&]*[/\\])?([A-Za-z0-9_.-]+\.mjs)\b/g)) {
    if (names.includes(m[1])) return true;
  }
  return false;
}

export const CREDENTIAL_NOTE =
  '[工具使用闸] 这条命令要读凭据库（auth.json / credentials.json / .env / *.pem 这类）。'
  + '读的时候一律只取**结构**——键名、条数、凭据类型、key 的前缀和长度——绝不把值打进输出：'
  + '值一旦落到会话记录里就等于泄露，而且它长得跟正常输出一样，没人会当场发现。'
  + '要看清形状就只 map 键名和 `type` 字段，`key`/`access`/`refresh` 一律不打印。';

/**
 * 命令文本是否在读一个凭据库。
 *
 * 判据来源：2026-09-13 一次读取 `~/.pi/agent/auth.json` 时整个 `key` 值被打了
 * 出来——十条供应商密钥进了会话记录。当时的本意只是「看清结构」，而输出里带了值。
 * 同一份纪律（只看前缀/长度/provider 名）早就写在全局约定里，缺的是触发。
 *
 * 与 tool-use-gate 其余判据同口径：**永不拦，只注**。判据轴是行为——命令文本
 * 指向凭据库就算命中，不区分 `cat` / `node -e` / `jq` / `grep`。
 * 误报面：这些名字出现在路径里就命中（比如 `grep -rn "auth.json" scripts/`），
 * 这可以接受——那种命令也确实是在拿凭据库当主题，提一句不亏。
 */
export function readsCredentialStore(command) {
  const cmd = String(command || '');
  if (!cmd) return false;
  // 前界用 `(?<![a-z0-9_])`——注意**允许前缀是 `.`**：`credentials?` 这种可选 s
  // 会把前面的点一起吃进匹配，于是 `~/.claude/.credentials.json` 的值命位前面
  // 是 `e`（来自 `claude`），点界被跳过了（2026-09-13 实测两轮才定位）。
  // 排掉的是紧贴标识符（`mycredentials.json`）和不点开头（`auth.json.md`）两种误报，
  // 这两种都另有一道下界兜着。
  // 后界用 `(?![\w.])` 而不是 `\b`：`.` 在 `\b` 眼里是词边界，`auth.json.md`
  // 会被 `\b` 判成命中（同一次实测）。
  if (/(?<![a-z0-9_])auth\.json(?![\w.])/.test(cmd)) return true;
  if (/(?<![a-z0-9_])credentials?\.json(?![\w.])/.test(cmd)) return true;
  if (/(?<![a-z0-9_])secrets?\.(?:json|ya?ml|toml)(?![\w.])/.test(cmd)) return true;
  if (/(?<![a-z0-9_])\.env(?:\.\w+)?(?![\w.])/.test(cmd)) return true;
  if (/\.(?:pem|p12|pfx)(?![\w.])/.test(cmd)) return true;
  return false;
}

export function classifyBash(command, { unitScripts = [] } = {}) {
  const cmd = String(command || '');
  const notes = [];
  if (isHeredocEscape(cmd)) notes.push({ id: 'heredoc-escape', text: HEREDOC_NOTE });
  // 根治版：与工具名无关，认「代码文本经 shell 落进文件」这个行为。旧判据命中时不重复注
  // （heredoc 是它的特例，两条都中只报一次）。
  else if (isShellEscapeIntoFile(cmd)) notes.push({ id: 'shell-escape-into-file', text: SHELL_ESCAPE_NOTE });
  if (isPythonStub(cmd)) notes.push({ id: 'python-stub', text: PYTHON_NOTE });
  if (isHandRolledSystemdRun(cmd, unitScripts)) notes.push({ id: 'handrolled-systemd', text: SYSTEMD_NOTE });
  if (readsCredentialStore(cmd)) notes.push({ id: 'reads-credential-store', text: CREDENTIAL_NOTE });
  return notes;
}
/** 注入给模型看的那段字。空 notes → 空串（hook 此时应闭嘴，不要吐空 JSON）。 */
export function renderToolUseGate(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return '';
  return notes.map((n) => n.text).join('\n');
}

/** 给用户看的短警告（systemMessage）。跟 additionalContext 同源，只是缩成一行。 */
export function renderWarning(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return '';
  const ids = notes.map((n) => n.id).join('、');
  return `[工具使用闸] 这条 Bash 命中了 ${ids}（不拦，只提醒）`;
}
