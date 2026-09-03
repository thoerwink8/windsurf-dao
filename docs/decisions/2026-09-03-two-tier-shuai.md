# 两级帅位：项目帅 + 总帅（先做薄）

日期：2026-09-03 ｜ 拍板人：用户 ｜ 出处：issue #852 正文「全量对话」拍板 + 同日定调评论

## 结论

- **项目帅** = 指挥官实例（#800 那套，每项目一份同代码不同 workdir）+ 项目群收需求。
  项目内派工/审查/合并默认静默自转。
- **总帅** = 总控群对话入口，**先做薄**：只做①路由（判断消息归哪个项目转项目帅）
  ②聚合（汇总各项目 situation/健康表答全局盘面）。不做第二大脑；跨项目调度
  （如抢工人配额）出现真需求再升级。
- **上行只有三类**（真相源 `docs/dispatch-policy.json` 的 `hubChat.upstream`）：
  红项过阈值（`redThreshold`，项目帅处理不了）/ 待拍板（`decisions`，过消歧门）/
  定期摘要（`digest`，可关）。总控安静 = 一切正常。
- 用户在哪说话都行：项目的事项目群直接办；跨项目/归属不明/全局盘面 → 总控。
- 看板 #818 与总帅同数据源：各项目态势文件聚合，接口是 projects[]（一项目一项，
  现在一个项目，结构上支持多个）。

## 依据

- 实咬（#852 正文）：探针/指挥官把「需要拍板」发进总控群，用户原地回复被
  HUB_GUIDANCE 打发——出题的地方不收答案。
- 消歧记录见 #852（总控收什么 / 拍板留痕在哪 / 谁来答盘面）。

## 落点

- 总帅入口第一版：`scripts/lib/feishu-triage-core.mjs`（hub 对话纯函数：待拍板 thread
  直落对应单、LLM 分类意图、聚合盘面作答、新需求才指路）+ `scripts/feishu-triage.mjs`
  （聚合读盘 `readHubContext`、hubPending 表、消费记录 `~/.dao/hub-chat/*.ndjson`）。
- 策略：`docs/dispatch-policy.json` 的 `hubChat` 节；取值范围由 dao-check 校验
  （`scripts/lib/dispatch-policy-check.mjs`）。
- 拍板留痕：复用 `gh issue/pr comment`，盘面问答只读，不新增动词。
