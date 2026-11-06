# 技术架构

## 总体结构

```
┌──────────────── 主线程 ────────────────┐      ┌────────── Sim Worker ──────────┐
│ Input ──► Command queue ──postMessage──┼─────►│ 60 tick/s 固定步长              │
│                                        │      │ World (TypedArray / ECS)        │
│ Renderer (PixiJS v8) ◄── Snapshot ◄────┼──────│ 每 tick 产出渲染快照            │
│ UI 面板 (Solid/Preact, DOM)            │      │ 存档序列化                      │
└────────────────────────────────────────┘      └─────────────────────────────────┘
```

- **模拟与渲染完全分离**。模拟不知道像素，渲染不改状态。
- 玩家操作一律转成 **Command**（`Place`, `Remove`, `Rotate`, `SetRecipe`, `Craft`, `Move`…），按 tick 编号进入模拟。这是确定性 / 回放 / 多人的基础。

## 技术栈

| 层 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript（strict） | 先求迭代速度；热点后续可换 Rust→WASM |
| 构建 | Vite | 快，原生支持 Worker |
| 渲染 | PixiJS v8 | 2D sprite 批量绘制最强，WebGPU/WebGL 双后端 |
| UI | Solid（或 Preact） | 面板/背包/科技树用 DOM，轻量 |
| 测试 | Vitest（单元/确定性）+ Playwright（E2E/截图） | |
| 存档 | IndexedDB + 二进制格式（可选 gzip/zstd-wasm） | |
| 部署 | Cloudflare Pages | 静态站点；需 COOP/COEP 头以启用 SharedArrayBuffer |

## 模拟核心

### 时间
- 固定 60 tick/s，模拟与帧率无关。Worker 内用累加器驱动；落后时最多追 N tick 后丢弃（单人）。
- 所有速度、进度用**整数**表示（如进度单位 = 1/65536，带上位置单位 = 1/256 格）。**禁止浮点进入模拟状态**，保证跨浏览器确定性。
- 随机数：种子化 PRNG（xoshiro128**），只在模拟内使用。

### 世界与分块
- 地图按 32×32 chunk 存储：地形 tile（Uint8Array）、资源量（Uint32Array）。
- chunk 惰性生成（simplex noise，整数化输出）。
- 实体空间索引：每 chunk 一个实体 id 列表 + 每格占用表（用于放置碰撞检测）。

### 实体存储
- 数据导向：每类实体一个 SoA（struct of arrays）表，`id → index` 稀疏集。
- 例：`Assembler { recipe: Uint16, progress: Int32, inputs: Uint16[k], output: Uint16, energy: Int32, state: Uint8 }`
- 不用通用 ECS 库，按 Factorio 的方式**每个系统特化**，热循环里只遍历紧凑数组。

### 更新顺序（每 tick）
1. 应用本 tick 的 Commands
2. 电网：计算每个网络的供需比
3. 采矿机
4. 传送带（transport lines）
5. 机械臂
6. 熔炉 / 组装机 / 实验室
7. 角色手工合成
8. 产出渲染快照 & 事件

顺序固定，写进测试。

### 传送带：Transport Line
Factorio 的核心优化，必须一开始就这么做：

- 相连的同向传送带合并为一条 **transport line**（每条带有 2 条 lane，各自独立）。
- lane 存的是**物品之间的间距**（gap 数组），而不是每个物品的绝对位置。
- 每 tick 只减少"第一个可移动间隙"的值 → 移动整条 lane 是 O(1)。
- 物品插入/取出（机械臂、侧面汇入）时局部更新。
- 放置/拆除带子时重建受影响的 line（合并/拆分）。
- 不动的满带 lane 进入睡眠。

### 机器休眠
- 实体状态：`Working | NoInput | OutputFull | NoPower | Idle`。
- 非 Working 的实体从活跃列表移除，挂到触发它的事件上（如"箱子有新物品""输出槽被取走"），被唤醒后再加入。
- 机械臂：等待拾取时只在源头物品变化时唤醒。

### 电网
- 电线杆用并查集维护连通网络；放置/拆除时增量更新（拆除时局部重建）。
- 每 tick 每网络：`satisfaction = min(1, 供给 / 需求)`，机器按比例减速。
- 发电机按需求出力，燃料按出力消耗。

### 配方与数据
- 所有原型（物品、实体、配方、科技）定义在 `src/data/*.ts`，启动时编译为数字 id 表。
- 数据有 schema 校验 + 测试（配方可达性：每个物品都能从原料合成出来）。

## 渲染

- 只渲染视口内 chunk（+1 圈缓冲）。
- 地形：每 chunk 烘焙成一张 RenderTexture，变化时重烘。
- 实体：按图层（地面→带上物品→建筑→机械臂→UI 覆盖）分 Container，sprite 池复用。
- 带上物品：按快照中的 lane 数据在主线程插值计算位置（可在两 tick 间插值让画面更顺）。
- 所有图集用 TexturePacker 或自写脚本打包。
- 缩放：放大看到细节，缩小到一定程度切换到 "地图模式"（色块）。

### 快照传输
- v1：Worker 每 tick 把**视口内**可见状态写入 transferable ArrayBuffer 发给主线程。
- 优化路径：SharedArrayBuffer 双缓冲（需要 COOP/COEP）。

## 存档 / 蓝图

- 存档 = 种子 + 所有已修改 chunk + 实体表 + 全局状态，二进制序列化，版本号 + 迁移函数。
- 蓝图 = 相对坐标的实体列表 → JSON → 压缩 → base64 字符串，可复制分享。

## 确定性与测试

- **确定性测试**：同一种子 + 同一 Command 序列，跑 N tick 后状态哈希必须一致（CI 中 Node 与 Chromium 各跑一次比较）。
- **系统单元测试**：传送带吞吐（每级带每秒物品数精确值）、机械臂节拍、组装机产出速率。
- **回放**：记录 Command 日志，可重放用于调 bug。
- **性能基准**：固定场景（1k / 10k / 50k 实体）测量平均和 P99 tick 耗时，CI 报告回归。

## 多人（v2+，仅预留）

- 确定性锁步：服务器只转发 Command，各客户端独立模拟；定期比对状态哈希检测不同步。
- 预留：Command 带玩家 id 与 tick；模拟中无任何本地时钟或浮点依赖。

## 性能目标

| 场景 | 目标 tick 耗时（16.6ms 预算） |
|---|---|
| 1k 实体 | < 1 ms |
| 10k 实体 + 5 万带上物品 | < 8 ms |
| 50k 实体 | < 16 ms（触发 WASM 迁移评估） |

## 目录结构（计划）

```
src/
  sim/            # 纯模拟，无 DOM 依赖，可在 Node 中运行
    world/        # chunk、地形生成、空间索引
    entities/     # 每类实体的 SoA 表与系统
    belts/        # transport line
    power/
    commands.ts
    tick.ts
    hash.ts
  data/           # 原型定义（物品、配方、科技）
  worker/         # Worker 入口，消息协议
  render/         # PixiJS 渲染层
  ui/             # DOM 面板
  main.ts
assets/           # 源素材（.aseprite / .png）
tools/            # 图集打包、benchmark 脚本
tests/
  sim/            # Vitest
  e2e/            # Playwright
```
