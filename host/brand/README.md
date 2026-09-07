# bot 头像

五只 bot 的 GitHub App 头像。**这里只放图，私钥归 C 类（不进 git，见 NEW-MACHINE）。**

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
| `dao-refiner` | `#bf3989` pink-500 | 倒分叉 | 一进两出：判完分派单队列 / 升级给人拍板 |

再加第六只时：底色继续在 Primer 里挑一个**和上面五个都拉得开**的，图形一句话说得清职责。

## 改之前必须知道的两件

1. **先在 30px 下看一眼**。评论列表就是 30px，糊了等于没有。
   `bot-watchdog.svg` 的注释里记了为此做的取舍（耳朵外斜否则读成猫、口鼻要探出头骨）。
2. **上传有一步藏起来的确认**。GitHub 设置页选完文件会弹「Crop your new avatar」，
   **必须点 `Set new avatar`**；只上传不点，页面显示 `Uploading…` 然后**静默失败**，
   头像仍是默认 identicon。2026-09-05 在这里栽过一次，以为传上去了。

## 怎么重新生成 PNG

真相源是 `bot-watchdog.svg` 与 `bot-refiner.svg`（另三只只有 PNG，是从 GitHub 拉回来的存档，没有矢量源）。

服务器上已装 Playwright，用无头 chromium 渲染，**顺带把 30px 自查图一起出**——
「先在 30px 下看一眼」这条规矩，靠人记会忘，让渲染脚本每次都吐出来就不会：

```js
const sized = (px) => svg.replace('width="200" height="200"', `width="${px}" height="${px}"`);
await page.setContent(`<body style="margin:0">${sized(400)}</body>`);
await page.locator('svg').screenshot({ path: 'bot-<role>.png' });        // 上传用
// 再渲一张 30px 的：评论列表就是这个尺寸
```

这一步不需要任何登录态，是 Linux 侧能自己做完的活。

## 画的时候踩过的（2026-09-05 refiner）

- **端头别加细节**。第一版画成「分叉 + 两个端头方块」，400px 下好看，30px 下三段糊成一团。
  小尺寸能活下来的只有轮廓，细节一律是负担。
- **笔画之间要互相压过一截，不能首尾相接**。相接会在接缝漏出底色——
  第一版的分叉口就漏出一个粉色的 X。
- **别画成认得出的字母**。正立的分叉就是字母 Y，撞「无文字」那条；倒过来既不是字母，
  语义还更对（一股从上面进来，往下分两路）。

## 换机 / 重装

图在这里，**私钥不在**。`~/.dao/apps/<role>.json` + `<role>.pem` 的装法见 NEW-MACHINE；
`gh-as.mjs <role> --whoami` 能跑通才算装好。
