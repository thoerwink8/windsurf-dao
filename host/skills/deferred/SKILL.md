---
name: deferred
description: 用户查看或处置已经入账的挂账（查现在挂了几条、给已有条目补背景、驳回、判定不做、改优先级）。用户说「看看挂账」「这条不做了」「给 D-001 补一句」「驳回这条」时读。硬边界：AI 不许用这个 skill 落账；AI 落账只有回复里写 [[挂账:]] 一条路。本 skill 没有新建命令。
---

# 挂账（用户侧）

这是**用户的操作入口**，不是落账机制。机制是 hook：AI 在回复里打 `[[挂账:]]`，Stop hook 搬走。

**硬边界：AI 不许用这个 skill 落账。AI 落账只有打标一条路。**  
否则会退化成「调个 skill 记一下」，整套设计被掏空，回到靠自觉。本 skill 没有 `add` / `create`，故意的。

用户在机制已经把条目摆到眼前之后，来这里处置或查询。hook 坏了时，这也是不依赖 hook 的写入路径（补信息 / 改状态），仍然不能新建。

## 查询

```bash
node scripts/deferred.mjs list
node scripts/deferred.mjs show --id D-001
```

空账本会说「0 条（扫完是空的）」。文件不在会说「没查成」，两形分得开。不要让用户去 `cat DEFERRED.md`。

## 追加信息

```bash
node scripts/deferred.mjs note --id D-001 --text "用户补充：其实和 #580 是同一类"
```

## 改状态

```bash
node scripts/deferred.mjs reject --id D-001 --why "不是问题"
node scripts/deferred.mjs wontfix --id D-001 --why "过期了，不做"
node scripts/deferred.mjs priority --id D-001 --to high
```

优先级只认 `high` / `normal` / `low`。驳回和不做都必须带原因。
