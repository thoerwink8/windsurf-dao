## 目标

第四席 `dao-watchdog[bot]`：看门狗报帅时用独立身份把事故写到 GitHub 评论，不再看过期屏、不再让卡住的人自报。署名 issue #673（关单交给 `scripts/close-issues.mjs`）。

## 验收标准

1. `scripts/lib/gh.mjs` 有角色 `watchdog`（`dao-watchdog[bot]`）。缺 `~/.dao/apps/watchdog.{pem,json}` fail-loud「这台机器没装」。权限：`issues:write`、`pull_requests:write`、`contents:read`、`checks:read`；**没有** `contents:write`。
2. `watchdog.mjs` 发出 `type: 报帅`（含连败阈值、不再自动动作的那一次）时，用 watchdog 身份在对应 PR 评论落盘；没有 PR 号则写关联 issue。正文固定头 `【看门狗】`，带卡名、指纹/原因、时间。同一树+同一指纹已报过不再刷。
3. snapshot / `--dispose-actions off` 不写 GitHub。
4. 写失败事件里报「GitHub 没写成」，不许当写成功。没 PR、没凭据、gh 失败分得开；评论列表「扫完 0 条」和「没扫成」分得开。
5. 测试走假 gh：正样本评论发出；负样本如上。工人不在 GitHub 上创建 App。
6. NEW-MACHINE 写清：人建 App `dao-watchdog`、装到本仓、pem/json 放到 `~/.dao/apps/`。
7. 正文不写 GitHub 自动关单词。`node scripts/dao-check.mjs` 过。

## 进展

- [x] 开工五步：空提交、draft PR #674、卡状态、标签
- [x] gh-as 加 watchdog 角色，缺凭据 fail-loud，contents 不许 write
- [x] 报帅写 GitHub 评论 + 去重 + 失败显形；snapshot / dispose-actions off 不写
- [x] 测试假 gh（正样本发出；没目标/没凭据/gh 失败分得开；扫完 0 ≠ 没扫成）
- [x] NEW-MACHINE：人建 App，工人不建
