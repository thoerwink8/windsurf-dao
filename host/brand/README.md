# bot 头像

四只 bot 的 GitHub App 头像。**这里只放图，私钥归 C 类（不进 git，见 NEW-MACHINE）。**

2026-09-05 建 `dao-watchdog` 时才发现：前三只的头像谁画的、什么规矩、丢了怎么补，
一个字都没记过——图只活在 GitHub 上。本页补这一格。

## 家族规矩（从前三只反推）

**纯色底 + 一个白色扁平图形。无渐变、无描边、无外框、无文字。** 底色取 GitHub Primer。

| bot | 底色 | 图形 | 为什么是它 |
|---|---|---|---|
| `dao-marshal` | `#bc4c00` orange-600 | 三角 | 指挥 / 尖端 |
| `dao-worker` | `#1a7f37` green-600 | 方块 | 砖块 / 干活 |
| `dao-reviewer` | `#0d419d` blue-700 | 对勾 | 判定 |
| `dao-watchdog` | `#8250df` purple-500 | 狗头 | 盯着 / 报警 |

再加第五只时：底色继续在 Primer 里挑一个**和上面四个都拉得开**的，图形一句话说得清职责。

## 改之前必须知道的两件

1. **先在 30px 下看一眼**。评论列表就是 30px，糊了等于没有。
   `bot-watchdog.svg` 的注释里记了为此做的取舍（耳朵外斜否则读成猫、口鼻要探出头骨）。
2. **上传有一步藏起来的确认**。GitHub 设置页选完文件会弹「Crop your new avatar」，
   **必须点 `Set new avatar`**；只上传不点，页面显示 `Uploading…` 然后**静默失败**，
   头像仍是默认 identicon。2026-09-05 在这里栽过一次，以为传上去了。

## 怎么重新生成 PNG

真相源是 `bot-watchdog.svg`（另三只只有 PNG，是从 GitHub 拉回来的存档，没有矢量源）。

浏览器里渲染即可，不必装图形库：把 SVG 塞进 `Image` → 画到 400×400 canvas → `toBlob('image/png')`。

## 换机 / 重装

图在这里，**私钥不在**。`~/.dao/apps/<role>.json` + `<role>.pem` 的装法见 NEW-MACHINE；
`gh-as.mjs <role> --whoami` 能跑通才算装好。
