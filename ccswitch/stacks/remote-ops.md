---
name: dao-stack-remote-ops
description: 远程执行工艺:SSH 嵌套引号/三层超时/heredoc 落远端文件。跨栈通用的远程操作处方。
---

# 远程执行处方（SSH 等）

> 慎终如始，则无败事。远程命令的失败往往死在引号转义与无超时挂死，不在业务本身。

## 触发

- 需要通过 SSH 在远端执行命令/脚本
- 任何「本地 shell 套远程 shell」的嵌套执行场景

## SSH 工艺铁律（自 dao.md 下沉，2026-07-07）

- **三层超时缺一不可**：`-o ConnectTimeout=<s>`（连接层）+ 远端 `timeout <s> <cmd>`（执行层）+ 长任务后台执行（会话层，`nohup ... &` 或 systemd-run）——任一层缺失都可能永久挂死调用方
- **复杂命令首选 heredoc 落远端文件再执行**，不在 ssh 参数里拼多层引号：

  ```sh
  ssh host 'cat > /tmp/job.sh' <<'EOF'
  # 脚本正文（单引号 EOF 保证本地零展开）
  EOF
  ssh host 'timeout 300 bash /tmp/job.sh'
  ```

- **禁反引号模板与 `$()` 插值**穿越 ssh 边界——本地展开还是远端展开无法一眼判定，是嵌套引号事故的头号来源
- 远端输出要判成败时，用显式 marker（`echo "EXIT=$?"`）而非猜测输出文本
