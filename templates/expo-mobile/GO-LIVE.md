# 上线须知（发版前必读）

三条硬规矩 + 一张检查清单。内容从 `wuganjiqie/mobile` 真机踩坑提炼，每条都有事故记录支撑。

## 一、签名密钥不进 git（红线）

- **任何签名/凭据文件一律不进 git**：`*.jks`、`*.p8`、`*.p12`、`*.key`、`*.mobileprovision`、`*.pem`。放进 `.gitignore`（见文末补充段），且**历史里也不能有**——已经误提交过就清历史，密钥当泄露处理，换新的。
- APK **必须签名才能安装**，debug 构建也要 debug keystore 签名。别用「不签名先发个包」这种想法——绝大多数手机装不上，白折腾。
- 密钥只放两台地方：本机私有目录、CI 的 secrets 存储。团队协作时用命令把密钥导出给新人，**不要通过聊天工具明文发**。

## 二、OTA 发布注意事项

OTA（expo-updates）只更新 JS 层，**不能新增 native 模块**——这是事故最多的坑：

1. **加了带 native 代码的依赖 = 必须重新构建并发布 APK**，再走 OTA。只发 OTA 会让老 APK 用户白屏崩溃。
2. **Expo 包版本用 `npx expo install <包名>` 装**，不要 `npm install`。Expo 包的版本由 SDK 严格约束，装错版本 prebuild 直接失败或运行时崩。
3. **`runtimeVersion` 变了必须重建 APK**：它标识 native 层版本，OTA 只对同版本客户端生效。改了 native 依赖/插件 → 递增 runtimeVersion → 重新构建 → 再发 OTA。
4. **CI 缓存要小心**：新增 Expo 插件后必须触发 clean build（清掉原生目录缓存重建），否则 OTA 的 JS 和 APK 的 native 对不上，App 永远显示旧页面。
5. **OTA 服务器端注意**：bundle/asset 端点**禁止 gzip 压缩**——expo-updates 客户端不解压，会写入损坏文件导致白屏。发布后 `curl -I <ota-url>` 看响应头确认没有 `Content-Encoding: gzip`。
6. 发完 OTA 立刻**真机验证**：杀掉 App 重开，确认拉到新版本（不要在开发机上验，环境不同）。

## 三、真机验收要求

「模拟器能跑」不算完成，**发版前必须真机过一遍**。真机验收按三区扫描截图（ADB 截图命令见文末）：

| 区 | 看什么 |
|---|---|
| 顶部 | header 是否显示、title 对不对、back 按钮存在且能返回 |
| 内容区 | 数据正确、加载中/空状态有显示、错误有提示（不许静默吞错） |
| 底部 | nav bar 完整、FAB 可点、手势条/刘海屏没遮挡内容 |

其它必查项：

- **SafeAreaProvider 必须包裹整个 App**，Tab bar 高度用 `useSafeAreaInsets()` 自适应——否则刘海屏/手势条设备内容被遮挡。
- **根层级必须有 ErrorBoundary**——RN 未捕获的 JS 错误 = 白屏，至少要让用户看到错误信息而不是白屏。
- 每个按钮点了要有反馈：成功有 toast、失败有错误提示。`catch {}` 吞错误在用户路径上绝对禁止。
- 交互元素必须有 accessibilityLabel（无障碍 + 自动化测试都能用）。

## 文末：移动端专属 gitignore 补充段

拷进 `.gitignore`（追加在 `base/gitignore-base.txt` 之后）：

```gitignore
# Expo
.expo/
dist-ota/
web-build/
expo-env.d.ts

# 原生构建目录（prebuild 产物，不进 git）
/ios
/android

# 签名密钥（红线）
*.jks
*.p8
*.p12
*.key
*.mobileprovision

# 本地环境变量
.env*.local
```

## 附：ADB 截图命令（Windows 正确姿势）

PowerShell 里 `>` 重定向会损坏二进制文件，截图必须用 `adb pull`：

```powershell
adb shell screencap -p /sdcard/tmp.png
adb pull /sdcard/tmp.png ./screen.png
adb shell rm /sdcard/tmp.png
```

查 OTA 日志：`adb logcat -s dev.expo.updates`
