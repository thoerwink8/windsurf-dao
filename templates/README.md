# 项目模板库

新项目从这里拿起点：**一份公共底座 + 按项目类型挑一层薄层**，拷进新仓库，按文件头部的说明填空、改名，就得到一个有协作约定、有 PR 模板、有 README 骨架、有 MCP 配置的规范项目。

## 怎么用（AI 或人都行）

1. **建新仓库**，比如 `my-new-project`。
2. **拷 base 全部**：`templates/base/` 里的所有文件拷到新仓库根目录。
3. **挑一层薄层**，拷进新仓库：
   - 要做 **Node 应用**（web 后端 / 桌面端 / 工具）→ 拷 `node-app/`
   - 要做 **移动端 App**（Expo / EAS 发布）→ 拷 `expo-mobile/`
   - 要做 **文档/知识库**（Obsidian vault、团队 wiki）→ 拷 `docs-vault/`
   - 一个项目可以同时拷多层的文件（比如「Node 后端 + Expo 移动端」），各文件独立不冲突。
4. **按文件头部说明填空/改名**：
   - `README-骨架.md` → 改名 `README.md`，填项目名、说明、跑法、测法
   - `gitignore-base.txt` → 改名 `.gitignore`
   - `.mcp.json` → 按需改 server 列表（说明见 `MCP-说明.md`）
   - `CLAUDE.md` / `PULL_REQUEST_TEMPLATE.md` → 删掉 `{{占位}}`，填真值；PR 模板拷进新仓库的 `.github/` 目录（如果没有就新建）
   - `package.json`、`eas.json` 等薄层骨架 → 删掉不需要的依赖，改名成项目真实名
5. **第一件该做的事**：按 CLAUDE.md 的约定，为第一个任务开 draft PR 再动手——从第一行代码开始就留痕。

## 模板都有什么

| 目录 | 类型 | 内容 |
|---|---|---|
| `base/` | 公共底座（任何项目都要） | CLAUDE.md 协作约定、PR 三段式模板、通用 .gitignore、README 骨架、MCP 配置骨架+说明 |
| `node-app/` | Node 应用薄层 | 目录结构建议、package.json 骨架（vitest 测试）、拼接说明 |
| `expo-mobile/` | 移动端薄层 | Expo/EAS 配置骨架、OTA 发布注意事项、真机验收要求、签名密钥红线、拼接说明 |
| `docs-vault/` | 文档/知识库薄层 | 目录组织建议、同步注意点、拼接说明 |

## 这个库是怎么来的

内容从三个真实项目提炼：`TraceyU`（Node/Tauri 应用）、`wuganjiqie` 的 `mobile/`（Expo 应用，含 OTA 和真机验收的血泪教训）、`ObsidianVault`（文档库）。拍板记录见 issue #425：**模板仓 = 1 公共底座 + 3 薄层**，模板让每个新项目一键获得一致的最佳实践起点。
