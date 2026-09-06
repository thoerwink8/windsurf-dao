# exhausted 改成 PR 属性：打标认输，不再开单（#1000）

署名 issue #1000，关单交给 `scripts/close-issues.mjs`。

## 目标

`exhausted`（自动化试满仍没推动）不再走 `escalate` 开「待拍板」单。改成 PR 上的状态：打 `卡死/自动化认输`、幂等评论、指挥官跳过该 PR，看门狗按 `pushed:<pr>@<head>` 推帅位一次。`dao now` 的「待你拍」列出带该标（以及 `卡死/等用户`）的 PR。

硬边界：不许改 `escalate` 的去重逻辑。

## 验收标准

1. 故意把某张 PR 的 drain tries 灌到上限，跑一轮 `decide` → 当场产 `mark-exhausted`（打 `卡死/自动化认输` + 一条说明评论：动词、次数、head）。不产 `open-issue` / `escalate(drain-exhausted)`。
2. 第二轮：PR 已带该标 → 不重复评论、不对该 PR 再 `retry-drain` / `rereview` / `rework`（省额度）。
3. 判别性反例：tries 未满不得产 `mark-exhausted`。
4. 看门狗：同一 `(pr, head)` 只推一次；改 head 允许再推；帅位移除 label 或换成 `卡死/等用户` 后不再推。账本键必须带 `@head`。
5. `dao now`「待你拍」列出带这两个 label 的 PR。
6. `wake-exhausted`（终端，不是 PR）仍走 `open-issue`，本单不动那条路。

## 进展

开工。实现后回填命令证据。
