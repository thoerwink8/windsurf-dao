# QA 工件凭据脱敏 · 两层防线（canonical · 约定名承载文件）

<!-- canonical 真相源：windsurf-dao `ccswitch/templates/qa-redaction-rule.md`。
     项目 `.claude/rules/qa-artifact-redaction.md` 从此派生 —— 复制过去后**只填「三、本项目实况」
     那一格**（哪条链在落工件、脚本叫什么、装在哪一步），前两节整段照抄不改写。
     判据与实现的真相源在 `ccswitch/lib/redact.js` 文件头，本文件也只是它的投影。 -->

## 一、两层是什么（各管一端，不是冗余）

| 层 | 管什么 | 入口 |
|---|---|---|
| **工件层** | QA / 诊断工件**落盘前**过一道脱敏 | `node <dao>/ccswitch/scripts/dao-redact.mjs --copy <src> <dest>` |
| **渲染层** | UI 渲染面上**不得出现配置里的真密钥**的自动断言 | `require("<dao>/ccswitch/lib/redact.js").assertNoSecretLeak(text, secrets)` |

两层的边界：工件层管**写进文件的东西**，渲染层管**显示在屏幕上的东西**——后者会经由截图、
录屏、结对演示离开本机，而那条路上没有任何过滤器。少哪一层都不叫接上了。

## 二、三条不许改写的判据

### 1. 🚧 射程：只管**文本**，不管截图

密钥在 PNG 里是像素，正则看不见它。**截图 / 录屏 / PDF / 任何二进制工件里的密钥，这两层
一个字都挡不住。** 这不是免责声明而是**行为**：`--copy` / `--in-place` 遇到二进制内容
**当场拒绝并 exit 2**（不是跳过、不是原样复制）——因为一个被静默跳过的二进制文件，
与一个真的脱敏过的文本文件，在调用方眼里长得一模一样，而前者是裸的。

⇒ 截图那一面归**流程**管：截图前把密钥输入框清空 / 用假 key / 走隔离实例。
**别因为"工件走过 redact 了"就认为截图也安全了。**

### 2. fail-closed：脱敏失败必须拒绝落盘，不许 `catch {}` 吞掉

这是本防线上移时修掉的最危险的一格。原实现是「先把原文件**复制到工件目录**，再对副本
就地脱敏」，而那一步包在**空 catch** 里 ⇒ 脱敏一旦抛错（文件被占用 / 编码异常 / 磁盘满），
**裸的那一份原样留在工件目录，没有任何人会知道**：函数返回、脚本继续、退出码 0、日志上
什么都没有。

调用侧照这个形态写，**别把退出码吞掉**：

```powershell
node "<dao>/ccswitch/scripts/dao-redact.mjs" --copy $src $dest
if ($LASTEXITCODE -ne 0) { throw "脱敏失败，拒绝落盘：$src" }   # 不要 try/catch 后继续
```

退出码四态：`0` 干净 · `1` **仅 scan 模式**扫到疑似凭据 · `2` fail-closed 失败 · `3` 用法错。
判成败写 `-eq 0`，**别写 `-le 1`**（那个区间把 scan 的命中也算成通过了）。

### 3. 渲染层的断言，**样本为空时必须红**

```js
const { collectSecretValues, assertNoSecretLeak } = require("<dao>/ccswitch/lib/redact.js");
const secrets = collectSecretValues(seededConfig);   // 从喂给被测程序的那份配置里收真值
await assertNoSecretLeak(await page.locator("body").innerText(), secrets, { label: "首页" });
```

`assertNoSecretLeak` 在**两种情况下主动抛错**，两条都是在防同一个病：

- **`secrets` 为空** ⇒ 断言恒为真，照常打印 PASS、照常被写进交付。**零违例与零样本不可区分。**
- **被检文本为空** ⇒ 页面没加载出来时 `innerText` 是 `""`，而 `""` 里当然不含任何密钥
  ⇒ **渲染失败会伪装成安全。**

诚实边界：它只做**精确子串**匹配。UI 把 key 截断显示（`sk-abc…`）或逐字符分片渲染时**夹不住**。

## 三、本项目实况（**这一格是派生时唯一要填的**）

<!-- 逐条填，填不出就写「本项目暂无此链」，别留空模板：
     - 哪条链在落工件：__________（如 `scripts/qa-full.ps1` 收集日志到 `dist/qa/run-*`）
     - 脱敏装在哪一步：__________（应当是**写入目标之前**，不是写完再擦）
     - 渲染层断言在哪：__________（如 `scripts/ui-smoke.js` 的每个 snapshot 点）
     - 本项目额外要脱的东西：__________（自有 token 前缀 / 内网域名 / 用户名，走 `redactFn` 注入）
     - 已知不覆盖的面：__________（截图、录屏、二进制工件、git 历史里的旧工件） -->

## 为什么必须是这个文件名

共性 rule 的**文件名契约**：跨项目自动核对的全部可能性都建立在文件名固定上。
内容可以项目化，**文件名不可**——否则被报「缺项」的项目总能说「我有这个规范，只是文件名不同」，
而清单的价值恰恰在于**无需语义理解即可核对**。
本文件对应 `ccswitch/scaffold-manifest.json` 条目 `qa-artifact-redaction`（`class: conditional`，
指纹是「这个仓有 QA 工件脚本」，见该条 `why`）。
