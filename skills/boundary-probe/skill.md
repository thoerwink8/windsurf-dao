---
name: boundary-probe
trigger: auto
description: 集成外部系统前，识别隔离机制并用最小穿透测试确认可行路径
---

# 边界探测术 · Boundary Probe

> 天下之至柔，驰骋天下之至坚。无有入无间。

## 适用场景

- 开发插件/扩展，需要与宿主系统交互
- 对接第三方 API、SDK、平台
- 任何需要跨越系统边界的集成工作

## 三步法

### 一、识壁（☲视·看见边界）

在动手前，先识别目标系统的所有隔离机制。

**常见的墙：**
- **存储隔离**：SecretStorage 按扩展 ID 隔离、Cookie 按域隔离、沙箱文件系统
- **权限隔离**：API Scope、OAuth 授权范围、CORS
- **进程隔离**：Extension Host vs Renderer、Worker vs Main Thread
- **加密隔离**：v10 加密存储、签名验证、证书锁定

**手法：**
- 读目标系统的扩展 API 文档（context7 查最新文档）
- 搜索目标代码中的 `scope`、`permission`、`isolation`、`sandbox`、`context`
- 查看数据存储格式——明文/Buffer/加密？谁能读？谁能写？

**产出**：隔离清单——每面墙标注类型和坚固程度

### 二、探路（☳触·最小穿透）

对每面墙，用最短代码测试能否穿过。

**原则：**
- 每次只测一面墙，一个操作
- 测试代码不超过 15 行
- 先读后写——只读成功了才尝试写入
- 记录精确结果：通/不通/条件通（什么条件）

**典型探测：**

```javascript
// 探测 1: 能否读取其他扩展的 SecretStorage？
const val = await context.secrets.get('other-extension-key');
console.log('跨扩展读取:', val === undefined ? '✗ 隔离' : '✓ 可读');

// 探测 2: 能否直接写 state.vscdb？
const db = new SQL.Database(fs.readFileSync(dbPath));
db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [newVal, key]);
console.log('DB直写:', '✓/✗');

// 探测 3: 文件是明文还是加密？
const buf = db.exec("SELECT value FROM ItemTable WHERE key LIKE 'secret://%'");
const head = Buffer.from(buf[0].values[0][0]).toString('utf8', 0, 3);
console.log('加密格式:', head); // "v10" = 加密, 可读JSON = 明文
```

**产出**：路径清单——每条路标注通/不通/条件

### 三、择水（☵听·选最柔路径）

> 水善利万物而不争，处众人之所恶。

根据探测结果，选择阻力最小的可行路径。

**选择优先级：**
1. 官方 API / 公开接口（最稳定，版本升级不易断）
2. 文件系统操作（明文存储可直接读写）
3. 数据库直改（需要进程互斥，但可行）
4. 运行时注入/猴子补丁（最强力但最脆弱）

**不可行时的降级：**
- 所有路径都不通 → 报告用户，不硬闯
- 只有猴子补丁可行 → 明确告知脆弱性，建议同时准备降级方案
- 部分路径有条件 → 文档化条件（如"需关闭目标进程"）

**产出**：选定路径 + 降级方案

## 实战模式

### 竞速模式（Race Pattern）

当同一资源有多条路径（直连/代理/备用）且不确定哪条通时：

```javascript
// 双路竞速：取先到的，另一条自动废弃
const result = await Promise.any([
  fetchViaProxy(url, data),    // 路径A: 代理
  fetchDirect(url, data)       // 路径B: 直连
]);
```

**适用场景**：网络封锁（GFW）、CDN 节点不稳定、多区域 API
**实例**：Firebase Auth 在 GFW 内直连超时，代理可达——双路竞速保证两种网络环境都能用

### 协议墙（Protocol Wall）

有时墙不是网络，是编码。

**诊断方法**：
- HTTP 404（而非超时）常意味着路径正确但协议错误
- `Content-Type` 不匹配：发 `application/json` 给期望 `application/proto` 的端点
- 响应是乱码而非 JSON：端点返回 protobuf，你用 JSON 解析

**实例**：Windsurf RegisterUser 返回 404，不是路径错——是发了 JSON 给 protobuf 端点。换成 `application/proto` + 二进制编码后立即通。

**教训**：撞墙时，先确认是你以为的那面墙。

### 三级降级模式（Three-Level Degradation）

不要只有一条路。每条路径都应有降级方案：

```
第一级：最优路径（无感知，零开销）
  ↓ 失败
第二级：可接受路径（有感知，低开销）
  ↓ 失败
第三级：保底路径（有中断，但能用）
```

**实例**：账号切换的三级降级：
1. 热切换（补丁命令注入，无重载）
2. state.vscdb + soft reload（codeium.restart）
3. state.vscdb + hard reload（workbench.action.reloadWindow）

设计时就写好三级，不要等第一级失败了才想降级。

## 与逆向拆解术的关系

```
逆向拆解术（阴·理解）  ←→  边界探测术（阳·验证）
     锚→展→交                识壁→探路→择水
         ↘ 验 ↙
        （合·知行合一）
```

逆向告诉你"它怎么工作"，边界探测告诉你"你能怎么接入"。
观而不验是空，验而不观是盲。

## 反模式

| 病 | 症 | 治 |
|----|----|----|
| 假通 | 读代码觉得能通，没实际试 | 每面墙必须有实际探测结果 |
| 硬闯 | 明知隔离还强行绕过 | 上善若水——换路不执着 |
| 过探 | 把所有可能的路径都测一遍 | 最多探三条，够用即止 |
| 忘退 | 没有降级方案 | 每条路径都备注“不通时怎么办” |
| 误判墙型 | 以为是网络墙，其实是协议墙 | 分析错误码：超时=网络，4xx=协议/认证，乱码=编码 |
| 单路依赖 | 只有一条路径，断了就死 | 设计时就写好三级降级，不要事后补 |
