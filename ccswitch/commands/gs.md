# /gs — Git Status 全景

执行 `git status` 并格式化输出，展示所有未提交的变更。

## 流程

1. 运行 `git --no-optional-locks status --short` 获取所有脏文件
2. 运行 `git --no-optional-locks diff --stat` 获取变更行数统计
3. 按状态分类展示：

```
📊 Git Status — <分支名>

  修改 (M):
    internal/config/config.go        +12 -3
    package.json                     +5 -2

  新增 (A/?):
    build.bat
    scripts/build-vendor-mac.sh

  删除 (D):
    （无）

  合计：X 个文件，+Y -Z 行
```

4. 如果工作区干净，输出 `✓ 工作区干净，无未提交变更`

## 规则
- 文件路径显示相对于仓库根的完整路径（不截断）
- M/A/D/? 用对应颜色区分（无需实际 ANSI，用 markdown 格式即可）
- 行数统计从 `git diff --stat` 的 summary 行提取
- 不执行任何写操作，纯只读
