---
name: dao-windsurf-extension
description: 平台探测方法论(L1接口→L2协议→L3行为→L4演化,穿过库抽象获得协议级理解)+ Windsurf/VSCode 扩展开发的已验证技术约束。逆向第三方平台、开发 IDE 扩展、或"高层库返回值与预期不符"时加载。
---

> MIGRATION-NOTE: 本 skill 含两类内容。
> 「四、平台探测方法论」(L1-L4 + 反模式)是**通用工程智慧**,Claude Code 下完全适用,价值最高。
> 「一~三」(Webview/globalState/Token 注入)是 **Windsurf/VSCode IDE 扩展专属**,仅当你确实在开发 IDE 扩展时有用;否则可忽略。是否精简由用户定。


# Windsurf 扩展开发术

> 知人者智，自知者明。

## 适用场景

- 开发 Windsurf / VSCode 扩展
- 涉及 webview、存储、认证等宿主系统交互

## 已验证约束

### 一、Webview 内联脚本禁令

**约束**：Windsurf 静默阻止 webview 中的内联 `<script>` 执行。不报错、不警告，脚本直接不运行。`enableScripts: true` 和 CSP nonce 均无效。

**症状**：

- webview HTML/CSS 正常渲染（按钮、样式可见）
- 所有 JS 交互失效（点击无反应、数据不显示）
- 扩展端 `postMessage` 正常发送但 webview 从不回消息
- 开发者工具无相关报错

**解法**：外部脚本文件 + `webview.asWebviewUri()`

```typescript
// resolveWebviewView 中
const mediaPath = vscode.Uri.file(
  path.join(this.context.extensionPath, "media"),
);
webviewView.webview.options = {
  enableScripts: true,
  localResourceRoots: [mediaPath],
};
webviewView.webview.html = this._getHtml(webviewView.webview);

// _getHtml 中
const scriptUri = webview.asWebviewUri(
  vscode.Uri.file(path.join(this.context.extensionPath, "media", "webview.js")),
);
// CSP 使用 webview.cspSource
// <meta http-equiv="Content-Security-Policy"
//   content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource};">
// <script src="${scriptUri}"></script>
```

**注意**：

- `media/` 目录需在 vsix 包中（无 `.vscodeignore` 排除即自动包含）
- `localResourceRoots` 必须包含脚本所在目录
- 内联 `<style>` 不受影响，仅 `<script>` 被阻止

**诊断方法**：在扩展端的 `onDidReceiveMessage` 回调加日志，确认 webview 是否发出消息。无消息 = JS 未执行。

### 二、globalState 存储

**机制**：`context.globalState` 底层存储在 `%APPDATA%\Windsurf\User\globalStorage\state.vscdb`（SQLite），按扩展 ID 隔离为 JSON 键值。

**约束**：

- 大数据量触发警告（>2MB 会输出 `large extension state detected`）
- 敏感数据建议用 `context.secrets`（OS 密钥链）或 `globalStorageUri`（文件系统）

### 三、Token 注入

**机制**：Windsurf 认证状态存储在同一 `state.vscdb` 中，键名以 `codeium.windsurf` 前缀。

**约束**：

- 直写 SQLite 需在进程外操作或使用 `sql.js`（纯 JS SQLite）
- 热切换需触发 `codeium.restartLanguageServer` 命令
- `sql.js` 的 `.wasm` 文件需包含在 vsix 中

## 构建与发布

**混淆注意**：`javascript-obfuscator` 的 `stringArray` + `controlFlowFlattening` 可能破坏模板字符串中嵌入的大段文本。外部化脚本后此风险消除。

**打包检查清单**：

- [ ] `media/` 目录包含在 vsix 中
- [ ] `node_modules/sql.js/dist/sql-wasm.wasm` 包含在 vsix 中
- [ ] `enableScripts: true` + `localResourceRoots` 正确设置
- [ ] CSP 使用 `webview.cspSource` 而非硬编码

### 四、平台探测方法论

> 库抽象隐藏机制。穿过库才能看见平台。

**原则**：用 `@connectrpc/connect` 等高层库调 API 只能获得**接口级**理解（函数名、参数、返回值），无法获得**协议级**理解（字段省略行为、零值语义、envelope 结构、多层 wrapper）。

**探测层次**：

| 层 | 看到什么 | 方法 |
|----|---------|------|
| L1 接口 | 函数签名、TS 类型 | 读库的 d.ts / proto 定义 |
| L2 协议 | 实际传输的字节、字段省略、envelope | 抓包或手动构造请求，对比原始响应 |
| L3 行为 | 429 退避、零值含义、重置时间、宽限期 | 长时间运行 + 统计分析 + 边界情况触发 |
| L4 演化 | 为什么这样设计、解决了什么痛点 | 读 changelog / 逆向旧版本 / 对比不同实现 |

**实践**：

- 当高层库返回的数据与预期不符时，**降到 L2**：直接 `fetch` 同一端点，对比原始字节与库的解析结果
- 当"应该有值但却是 0/undefined"时，检查 proto3 零值省略——`0` 和 `缺失` 对 proto3 不可区分
- 当不同账号表现不一致时，记录**完整响应**（含 envelope），不只看业务字段
- 积累观测，从**统计异常**中发现规律（如"Daily reset 总在某个固定时间"）

**反模式**：

| 病 | 症 | 治 |
|----|----|-----|
| 库信任 | "connect 库返回 0 就是 0" | L2 检查：字段存在还是省略？ |
| 单次观测 | "这个号 planEnd 过期就是死号" | 多号对比：过期+有配额 vs 过期+无配额 |
| 假设重置 | "重置时间大概是每天零点" | L3 实测：记录连续多日的 resetUnix |

## 与其他技能的关系

```
边界探测术 → 发现约束 → 记录于此
逆向拆解术 → 理解机制 → 记录于此
此技能 → 为未来 Windsurf 扩展开发提供已验证的路径图
平台探测方法论 → 穿过库抽象，获得协议级理解
```
