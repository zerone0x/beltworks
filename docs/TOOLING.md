# 工具链与工作流

## 参考项目

| 项目 | 用途 |
|---|---|
| [tobspr-games/shapez-community-edition](https://github.com/tobspr-games/shapez-community-edition) | 开源网页工厂游戏：带系统、建造交互、存档、chunk 渲染的实现参考 |
| [JackHopkins/factorio-learning-environment](https://github.com/JackHopkins/factorio-learning-environment) | 配方/实体数据建模参考 |
| Factorio Friday Facts（官方博客） | 传送带优化（FFF #176）、机械臂、电网等设计细节 |
| [Game Programming Patterns](https://github.com/Tingtingyu/Game-Programming-Patterns-CN) | 游戏循环、命令模式、数据局部性 |
| [awesome-learn-gamedev](https://github.com/dawdle-deer/awesome-learn-gamedev) | 通用资料 |

> 只参考设计思路，不复制代码（shapez CE 为 GPL-3.0，需注意许可证）。

## 美术

- [Aseprite](https://github.com/aseprite/aseprite) / [Pixelorama](https://github.com/Orama-Interactive/Pixelorama)：sprite、tileset、动画
- AI 生成占位图 → 手工修整
- [anatomy skill](https://github.com/wheresryan22/anatomy)：机器概念图
- 图集打包脚本：`tools/pack-atlas`

## Agent 工作流

| 工具 | 用在哪 |
|---|---|
| [pstack](https://github.com/backnotprop/pstack) `architect` + `arena` | 关键架构决策（实体存储、快照协议、WASM 迁移） |
| pstack `tdd` | 模拟系统一律先写测试 |
| pstack `statechart` | 机械臂、组装机状态机建模 |
| pstack `benchmark-checklist` | M4 性能工作 |
| pstack `create-verification-skill` | 做一个"启动游戏 → 执行脚本化操作 → 截图 + 断言"的验证 skill |
| [gstack](https://github.com/garrytan/gstack) | 计划评审、浏览器 QA |
| [Claude-Code-Game-Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) | 游戏设计迭代、平衡数值 |
| [planning-with-files](https://github.com/OthmanAdi/planning-with-files) | 长周期任务的持久化计划 |

## 开发约定

- `src/sim` 不得 import DOM / PixiJS / `Math.random` / `Date.now` / 浮点运算结果写入状态（lint 规则强制）。
- 每个 PR：单元测试 + 确定性测试通过；涉及 sim 热路径的 PR 附 benchmark 结果。
- 视觉相关 PR 附 Playwright 截图。
