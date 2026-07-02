---
name: dao-stack-backend-go
description: 后端技术栈处方:Go——go mod + net/http(chi) + sqlc,标准库优先。高并发/CPU 密集/系统级/单二进制分发的条件备选。
---

# Go 后端处方（条件备选）

> 反者道之动。默认走 TS 一以贯之（`backend-ts.md`）；以下信号出现，则反向切 Go。

## 触发信号（任一出现即切，否则不用）

- **高并发**：大量长连接 / 高 QPS / 重 I/O 多路复用
- **CPU 密集**：数据处理、编解码、算法内核
- **系统级**：CLI 工具、daemon、与 OS 深度交互
- **单二进制分发**：目标环境无运行时依赖，一个可执行文件交付

kit STACK.md 声明 `stack: backend-go` 视为信号已由上游判定，直接挂本处方。

## 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 模块 | go mod | 标准，无第二选项 |
| HTTP | `net/http`（Go 1.22+ 路由增强）；路由/中间件复杂才上 chi | 标准库优先，chi 零反射兼容 `net/http` |
| DB | sqlc + `database/sql` | SQL 即真相，生成类型安全代码，无 ORM 魔法 |
| 配置/日志 | 标准库（`flag`/`os`/`log/slog`） | 够用不引框架 |

## 结构骨架

```
cmd/<app>/main.go    ← 入口（薄，只做装配）
internal/            ← 业务逻辑（编译器强制不可外引）
  handler/  service/  store/
db/
  migrations/  queries/   ← sqlc 输入
```

## 铁律

- **标准库优先**：每个第三方依赖要有一句话理由
- **错误显式**：`fmt.Errorf("...: %w", err)` 包装上抛，不吞错、不裸 panic
- **internal 收权**：业务逻辑进 `internal/`，公开面只留 cmd 与显式 API

## 与前端的类型契约

Go 侧无 shared-types——API 契约用 OpenAPI（或 JSON Schema）导出，前端据此生成 TS 类型；契约文件入库，改契约先改文件再改两端。

## 验证

依次运行：`go vet ./...` → `go test ./...` → `go build ./...`。三者全绿才算就绪。
