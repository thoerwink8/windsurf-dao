---
name: dao-windsurf-extension
description: Windsurf扩展开发的已验证技术约束与最佳实践
---

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

## 与其他技能的关系

```
边界探测术 → 发现约束 → 记录于此
逆向拆解术 → 理解机制 → 记录于此
此技能 → 为未来 Windsurf 扩展开发提供已验证的路径图
```
