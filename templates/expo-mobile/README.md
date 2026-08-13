# Expo 移动端薄层

给「移动端 App」类项目（Expo / EAS 发布）的起点。与 `base/` 拼装，见文末。

## 这层给什么

- **Expo/EAS 配置骨架**：`eas.json`（development/preview/production 三档构建）+ `app.json`（应用元信息 + OTA 开关）
- **上线须知**（`GO-LIVE.md`）：OTA 发布注意事项、真机验收要求、签名密钥不进 git 的红线——都是 `wuganjiqie/mobile` 真机踩过的坑提炼的，不是纸上谈兵
- 技术栈基线：Expo SDK 54 + expo-router + TypeScript（实盘验证）

## 怎么和 base 拼出新项目

1. 拷 `base/` 全部 + 本目录全部到新仓库根目录。
2. **改 `app.json`**：name（App 显示名）、slug、scheme、`android.package` / `ios.bundleIdentifier`（上架后不可改，先想好）。`{{公司}}`/`{{项目}}` 占位换成真值。
3. **改 `eas.json`**：按需调整构建档位（见下方「三个档位」）。
4. 装依赖：`npx create-expo-app` 或手动 `pnpm install`。**Expo 相关包一律用 `npx expo install <包名>` 装**（Expo 包的版本由 SDK 严格约束，`npm install` 装出来的版本很可能 prebuild 失败或运行崩溃）。
5. 建路由骨架：`app/` 目录 + 根 `_layout.tsx`（expo-router 约定）。
6. 把 `base/.gitignore` 之外再补一段移动端专属忽略（见 `GO-LIVE.md` 末尾的 gitignore 补充段）。
7. 按 `base/README-骨架.md` 填 README；跑通一次真机构建后开第一个 draft PR。

## 推荐目录结构（expo-router）

```
mobile/ 或仓库根/
  app/
    _layout.tsx       ← 根布局（Stack 导航），新页面必须在这里显式注册
    index.tsx         ← 首页
    (tabs)/           ← 底部 Tab 分组
  components/         ← 复用组件（不含页面）
  hooks/              ← 自定义 hooks
  services/           ← API 客户端、外部服务
  utils/              ← 纯工具函数
  assets/             ← 图标、splash、字体
```

## 三个构建档位（eas.json）

| 档位 | 用途 | 关键配置 |
|---|---|---|
| `development` | 日常开发调试 | developmentClient + debug APK（可连 Expo Dev Client） |
| `preview` | 给真人测试的安装包 | release APK；建议只编 arm64（`-PreactNativeArchitectures=arm64-v8a`），体积减半，2020 年后手机全兼容 |
| `production` | 上架商店 | app-bundle（Google Play 要求） |

## 版本红线

- **`runtimeVersion`（app.json）必须与 APK 里的 native 层一致**：OTA 只对同 runtimeVersion 的客户端生效。改了 native 依赖/插件就递增它，并重新构建 APK。
- 每个 Expo 包只认一个 SDK 版本，混装不同 SDK 版本 = 白屏/崩溃。

## 文件清单

| 文件 | 干什么 |
|---|---|
| `eas.json` | 三档构建配置骨架，直接用 |
| `app.json` | 应用元信息 + OTA 开关骨架，改名填值 |
| `GO-LIVE.md` | 上线须知：OTA / 真机验收 / 签名密钥红线 |
