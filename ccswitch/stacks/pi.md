---
name: dao-stack-pi
description: pi 编码代理部署处方——自定义 provider（new-api 网关）+ 4 模型配置 + 自动压缩参数 + 实测坑。换机照此文独立完成安装/配置/验证。
---

# pi 编码代理部署处方

> 千里之行，始于足下。换一台机器，照此文走完安装 → 配置 → 验证，不用再回来问人。

出处：issue #302（2026-08-10 本机实装实测通过）。本文是换机/新机的**唯一处方**，真实 API key 不在此文（也不在任何进 git 的文件里），只在各机器本地 `~/.pi/agent/models.json`。

## 触发

- 新机器要装 pi 编码代理
- 要给已有 pi 接入内部 new-api 网关
- pi 行为异常（压缩阈值 / 工具调用乱码）排查

## 1. 安装

```sh
npm install -g @mariozechner/pi-coding-agent
```

⚠️ npm 包名与 CLI 名不同：包是 `@mariozechner/pi-coding-agent`，命令是 `pi`。**`@mariozechner/pi` 是另一个 vLLM 管理工具，别装错。**

## 2. `~/.pi/agent/models.json`（自定义 provider）

```json
{
  "providers": {
    "new-api": {
      "baseUrl": "http://10.213.196.114:3000/v1",
      "api": "openai-completions",
      "apiKey": "<从 new-api 面板生成>",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "reasoning": true, "input": ["text"], "contextWindow": 300000, "maxTokens": 32768 },
        { "id": "glm-5.2", "name": "GLM 5.2", "reasoning": true, "input": ["text"], "contextWindow": 800000, "maxTokens": 32768 },
        { "id": "gpt-5.6-luna", "name": "GPT 5.6 Luna", "reasoning": true, "input": ["text", "image"], "contextWindow": 800000, "maxTokens": 32768 },
        { "id": "kimi-k3", "name": "Kimi K3", "reasoning": true, "input": ["text", "image"], "contextWindow": 300000, "maxTokens": 32768 }
      ]
    }
  }
}
```

🔴 **API key 绝不写真实值**——真实 key 只存在于各机器本地 `~/.pi/agent/models.json`，不进仓、不进 issue、不进任何进 git 的文件。新机器上从 new-api 面板生成后只填这一格。

## 3. `~/.pi/agent/settings.json`

```json
{
  "defaultProvider": "new-api",
  "defaultModel": "deepseek-v4-flash",
  "compaction": {
    "enabled": true,
    "reserveTokens": 32768,
    "keepRecentTokens": 32768
  }
}
```

## 4. 设计决策（写下来让后人不误改）

- **4 个模型真实上下文都是 1M**（网关 `/api/pricing` description 字段 + GLM-5.2 官方文档），但 `contextWindow` **故意声明得更小**：pi 无百分比压缩阈值，触发公式是 `已用 > contextWindow − reserveTokens`（源码 `compaction.js:152` 核实）。worker 常用的两个模型（deepseek-v4-flash / kimi-k3）声明 **300000**——压缩早触发，单请求峰值受控（长会话实测过 428k/请求的账单曲线后收窄）；worker 的状态都在盘上（提交/任务书），丢会话旧细节无伤。另两个模型保持 800000。想用满 1M 改回 1000000。
- `supportsDeveloperRole: false` + `supportsReasoningEffort: false`：网关代理场景的兼容设置（pi 官方文档对 OpenAI 兼容代理的建议）。
- gpt-5.6-luna 计费分层：输入超 272K 后单价翻倍，长上下文任务留意。

## 5. 已知坑（实测定位）

- **deepseek-v4-flash 勿用 `--tools` 裁掉 bash**：裁掉后模型仍幻觉调用 bash，上游 DSML 解析器匹配不到未声明工具，把 `<｜｜DSML｜｜tool_calls>` 原文当纯文本吐出（非网关流式 bug，curl 流式+声明工具实测正常）。agent 任务用默认工具集。

## 6. 验证（新机器配完自检）

```sh
pi --list-models new-api        # 应列出 4 个模型
pi --no-tools --no-session -p "只回复：OK"   # 端到端冒烟
```

两条全过 = 部署完成。第一条不过 → 查 `models.json` 路径与 JSON 合法性；第二条不过 → 查 apiKey 与网关连通性。
