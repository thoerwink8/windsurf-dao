---
name: webview-debug
description: 桌面界面调试：要看跑着的桌面应用界面、调试 WebView/Web 窗口或 playwright/chrome-devtools 连错实例时读。选工具树、端口三条、归属验证，以及两个被实证证伪的旧处方墓碑。
---

# 桌面界面调试

## 选工具树

- 有 WebView 层 → chrome-devtools MCP
- 纯 Web → playwright MCP
- 原生 Win32 → PowerShell .NET 截图
- windows-mcp 一律不用
- 同一会话只用一个浏览器工具，不中途换

## 端口三条

1. chrome-devtools 无 `--browser-url` 参数默认连固定 9222——后启动的会连到先占者，`list_pages` 显示的是别的应用。
2. 端口被占的正解是换端口另起，不是清场——占用者的正常形态就是用户正在用的实例。
3. WebView2 调试端口按 user-data-dir 绑定、不按进程：共用同一 user-data-dir 时，光换端口号仍会静默失败。

## 归属验证

看端口 Listen 者的祖先链里含不含你刚起的 app PID——`/json` 的 title 不算证明。

## 墓碑（被实证证伪的旧处方，别从旧快照搬回来）

- `Stop-Process -Force` 清场
- 每个项目分配固定唯一端口
