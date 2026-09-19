# kit：直接落到子仓的东西

`kit/` 里的文件**零依赖**，可以整份复制进子仓（`node --check` 能过、不需要 npm install）。

| 文件 | 干什么 | 子仓怎么接 |
|---|---|---|
| `conventions-core.mjs` | 纯判据（解析约定块 / 豁免段，判三态） | 不用动，跟着 `check-conventions.mjs` 一起复制 |
| `check-conventions.mjs` | 子仓 CI 的入口：校验约定块 + pin + 豁免理由 | CI 里跑 `node <路径>/check-conventions.mjs`；退出码 0=绿 / 1=红 / 2=没查成 |

## 子仓接一次，此后强制

1. 在真相源仓跑 `node host/conventions/stamp.mjs --print`，拿到那行块；
2. 贴进子仓 `AGENTS.md`（顶层，不要塞进别的小节里）；
3. 把 `{ "version": …, "sha256": … }` 抄进子仓 `.dao/conventions.json`；
4. CI 加一步 `node kit/check-conventions.mjs`（`--expected-version` 传真相源的版本号，落后即红）。

## 三态为什么用退出码分开

`0` 绿 / `1` 红 / `2` 没查成。宿主（CI、hook）看得到 `2`——把「没查成」当绿，就会把
「这次没扫到样本」读成「查过没事」，这是本仓判例 C1 的直接落地。

## 豁免怎么写

子仓做不到某条不可协商项时，在 `AGENTS.md` 写：

```md
## 豁免

- C7: 本仓的 CI 只跑单元测试，没有墙钟闸，所以不适用
```

**每条必须带理由**，没有理由的条目检查器直接判红（C2）。理由写「为什么这条不适用」，
不是「先关掉」。
