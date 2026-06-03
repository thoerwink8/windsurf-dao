# dao-ui-mockup · 调用示例

> 见诸行而知诸言。例子永远比定义有说服力。

## 前提:先过分诊门

本 skill 不自启动。任何 UI 任务先过 `dao-design-taste` §0 分诊,只有 **FULL / SCOPED** 档才调用本 skill;**DIRECT** 档跳过(查 gallery 直接写代码)。

## 调用模板

### FULL 档:项目启动 / 换肤 / 大重构(五步法)

```
用户:"帮我重设计这个应用的主题,目前样式太丑"
     ↓
dao-design-taste §0 分诊 → 整套视觉重定 = FULL → 调本 skill
     ↓
一·察 → 读项目 AGENT/README/TODO + 关键源码 + 截图现状
        产出:项目画像(本质 / 目标用户 / 关键场景)
二·援 → 配色/字体方向从供给源取候选(优先级):
        1. ui-ux-pro-max(若注入)→ 按画像检索其 palettes/styles/typography
        2. 用户点名的产品 / 贴的截图 / 链接
        3. 基石 §4 准则直接定(禁 AI 紫 / 单一强调 / 字体有性格)
        🔒 AskUserQuestion 等用户拍板方向(路歧关卡,不可替选)
三·拟 → 合成 N 套方向,受基石 §2 三旋钮 + §4 判据约束
        多样性:N≥2 时方向显著不同(明/暗、衬/无衬、密/疏)
四·显 → 生成 _tmp/ui-mockup-<topic>-<ts>.html(throwaway 思考脚手架)
        方向切换 + 暗色 + Foundations + 关键组件 + 真实场景
五·择 → "请在浏览器打开 file:///.../<html> 选定方向或告诉我微调"
        🔒 等用户响应
        选定后导出唯一长期产物:_tmp/design-tokens-<topic>.json
        HTML 归档,不写测试、不当 ground truth
```

### SCOPED 档:加一块形态未知的新功能(局部探索)

```
用户:"加一个我没做过的可视化拖拽编排界面,不知道长啥样"
     ↓
dao-design-taste §0 分诊 → 单功能形态未知 = SCOPED → 调本 skill
     ↓
- 一·察 只扫与这块功能相关的上下文,不全量
- tokens 不动(沿用现有)
- 二~五 只画这一块功能的 HTML,不重走全量组件库
- 选定后这块的形态明确 → 实现 → 补进 gallery
```

### Style Tile(快速对比,FULL/SCOPED 皆可简化)

```
用户:"先快速看 2 个方向,不要细节"
     ↓
- 二·援 仍走(方向不凭空发明)但候选压到 2-3
- 三·拟 → 四·显 生成简化 HTML(仅 Foundations + 1 场景)
- 跳过完整组件库,让用户 1-2 分钟拍板大方向
- 选定后再启完整流程细化
```

## 反例(什么时候不调用)

| 场景 | 分诊档 | 为什么不调用 |
|---|---|---|
| "把按钮颜色改成蓝色" | DIRECT | 已知形态微调,直接做 |
| "新增一个纯逻辑 Hook" | — | 无视觉决策 |
| "修复测试" | — | 不涉及 UI |
| "已经有 design tokens 了" | DIRECT | 跳过本 skill,直接落地 |
| "加个标准 CRUD 表单" | DIRECT | 形态已知,查 gallery 复用现成 |
| "加个全新交互范式,说不清长啥样" | SCOPED | **调用**,只画这一块 |
| "整个产品换肤" | FULL | **调用**,全量 |

> 判据是「未知量」不是「改动大小」:标准新功能可能是 DIRECT,老页面加新交互可能要 SCOPED。详见 dao-design-taste §0。

## 与 /dao-superpowers 的协作示意

```
/dao-superpowers 第 2 步 · 谋
  ├─ 2.0 · 形(dao-design-taste §0 分诊)⭐
  │   ├─ DIRECT → 跳原型,查 gallery → 直接写 plan
  │   └─ FULL/SCOPED → 调 dao-ui-mockup:
  │       ├─ 一·察 → 项目画像
  │       ├─ 二·援 → 供给源取候选 + 拍板方向 🔒
  │       ├─ 三·拟 → 合成 N 套(受基石判据约束)
  │       ├─ 四·显 → _tmp/ui-mockup-<topic>-<ts>.html(throwaway)
  │       └─ 五·择 → 用户拍板 🔒 → 导出 design-tokens.json
  └─ 2.1 · 写 plan(引用 tokens 路径)
  ↓
第 3 步 · 造(implementer 引用 tokens + 复用 gallery 组件)
  ↓
第 4 步 · 审(reviewer 过 dao-design-taste §6:体检表 + preview 真实渲染)
  ↓
第 5 步 · 归
```

> HTML 不参与第 3/4 步——它是探索期的 throwaway,代码即真相,验收看 preview 不看 HTML。

