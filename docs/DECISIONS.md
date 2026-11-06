# 决策记录

## 已定

| # | 决策 | 理由 |
|---|---|---|
| D1 | 俯视 2D，网格 | 工作量最小，玩法核心不依赖 3D |
| D2 | PixiJS v8 而非 Phaser | 只需渲染层；物理、场景管理用不上，PixiJS 批量绘制更轻更快 |
| D3 | 模拟跑在 Web Worker | 主线程只负责渲染和输入，避免卡顿 |
| D4 | 模拟全整数、确定性 | 存档可靠、回放调试、为多人预留 |
| D5 | 传送带用 transport line + gap 数组 | 业界验证过的唯一可扩展做法 |
| D6 | 先 TypeScript，数据按 TypedArray 设计 | 迭代快；需要时低成本迁移 WASM |
| D7 | v1 单人，无战斗、无流体 | 聚焦核心循环 |
| D8 | 原创名称与素材 | 避免版权问题 |

## 待定

| # | 问题 | 何时决定 |
|---|---|---|
| Q1 | UI 框架：Solid 还是 Preact | M0 开始时 |
| Q2 | 快照传输：transferable buffer 还是 SharedArrayBuffer | M4 基准测试后 |
| Q3 | 是否以及何时迁移 Rust→WASM | M4 |
| Q4 | 美术风格最终定稿（像素 vs 扁平矢量） | M1 结束前，先用占位图 |
| Q5 | 项目正式名称（暂名 Beltworks） | 公开测试前 |
