# Electron 桌面项目只发 portable 单形态（2026-09-01 拍板）

## 起因

ws-cleaner 与 miraquota-win 的 CI 产物都是「NSIS 安装版 + portable」两个 exe，各 ~95MB。
两者都是整套 Electron 运行时（解包 ~325MB，压缩后即 95MB），内容 99% 重复——纯冗余。
根因是配置继承：ws-cleaner 的 `build.win.target` 从 miraquota-win 抄来，双 target 是模板默认值问题，不是流程失控。

## 结论

- **新 Electron 项目默认只配一个 target：`portable`**（个人工具下载即用；确有安装/开始菜单需求时再加 nsis，一事一议）。
- 不设 hook/检查级约束：target 配几个是产品决定，机器判不了对错；改掉「事实模板」miraquota-win 的默认值即可，后续项目照抄自然继承。

## 已落地

- ws-cleaner `f995116`、miraquota-win `7849024`：砍 nsis target，CI/Release/文档同步只提 portable。
- 历史产物清理正则（两仓 dist.mjs 的 OLD_ARTIFACT）保留 Setup 匹配，兜旧文件。
