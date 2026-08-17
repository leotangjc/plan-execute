# dsh-plan-execute

![version](https://img.shields.io/badge/version-0.1.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)

**让 DeepSeek Harness 帮你「先想清楚 → 列好计划 → 干完验收」。说一句「计划实施」就开工。**

一个插件，两种模式：**light**（简化，缺省）和 **heavy**（完整防御），配置切换。

## 它能干什么

把「问清楚 → 写计划 → 干活验收」串成一条龙，随时能停、计划是普通文件能交给别人、绝不悄悄覆盖已有计划、全程中文。

- ⏸️ **随时能停**：记录都存成文件，下次说「继续」接着干；
- 🤝 **能交给别人**：计划是普通文本，可甩给别的 agent 或同事；
- 🛡️ **不乱动你的东西**：发现同名旧计划先问你，绝不悄悄覆盖。

## 安装

```bash
dsh plugin --profile web add github:leotangjc/plan-execute
```

> `--profile` 填你实际用的 profile（`web` / `tui` / 自定义名）。装完**重启 DSH**。

**GitHub 直连不通时（大陆网络）**，镜像 clone 再装：

```bash
git clone --depth 1 https://ghfast.top/https://github.com/leotangjc/plan-execute.git && cd plan-execute
dsh plugin --profile web add .
```

> 装完**保留 clone 目录**（`file:` 依赖，删了插件就断）。三个实测坑：被沙箱拦 → 用 `danger-full-access` 重跑；pnpm 白名单 → 去 `pnpm-workspace.yaml` 加 allowBuilds key；装完要重启。

## 怎么用

两种方式进入流程：说「计划实施 / 编译计划 / 执行计划」，或默认触发（需求模糊/多步骤/项目级任务）。说「直接做」跳过。

**light 模式**（缺省）：

```
你：计划实施
它：新建计划「proj」。请确认任务列表。
你：建页面、接接口、写测试
它：确认后开始执行？
你：开始
它：执行验收开始（3 个任务）……
你：进度
它：【进度】2/3 完成 - 已完成：T1、T3 - 未完成：T2 - blocked：T2 等上游
```

任务状态 = `proj.md` 勾选行（`- [x] T1: 标题`），打开文件扫一眼就知道干到哪了。

**heavy 模式**：完整流程 grill（先问清楚）→ compile（两层确认）→ execute（执行验收），带审计日志和活动指针。

**切模式（两种方式）**：
- **设置界面**（DSH rc.7+）：设置页 → 插件 → dsh-plan-execute → 选 light/heavy、开关 autoTrigger、改默认项目名——界面点选，无需改文件。
- **preset 组合行**（老方式）：agent.cordis.yml 插件行加 `config.mode: heavy`（或省略用 light）。

> 设置界面改完**重启生效**（mode 切换涉及文件契约不同，热切换有风险）。

## 记录存在哪

```
<你的工作目录>/
├── proj.md                # light：计划 + 进度（勾选行 = 状态真相）
└── .plan/
    └── proj.meta.json     # 阶段指针 + 偏差（引擎写，别手改）
```

heavy 模式用 `.grill/` + `.plan/`（md + meta + 日志 + 指针）。

## 常见问题

- **工具名为什么是英文？** 平台规定工具名只能英文数字下划线连字符，中文会报错。
- **会抢着替我做决定吗？** 不会。逐题等你回答、绝不替你拍板。
- **需要装 Node 吗？** 不用，包里带成品；改代码才需要。
- **状态会静默搞错吗？** 不会。light 状态真相在 md（看得见，忘勾会被收尾闸门拦）；heavy 报告只统计 meta 快照。都杜绝静默撒谎。

## 已知限制

- 它负责「闸门与统计」，不负责替你想——问什么、怎么写、怎么验收由 agent 做（以你为准）；
- 默认触发靠模型判断，可能漏触发或过度触发——说「直接做」可跳过，或设 `autoTrigger: false`；
- light：同一计划同时只在一个会话跑；heavy：老计划（无快照）报告显示暂无状态；
- 没有撤销/回滚，想留历史把你的工作目录放进 git。

## 开发者

```bash
npm test         # 71 个用例（light 20 + heavy 51）
npm run build    # 重新编译（改完记得提交新产物）
```

内部结构见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。完整介绍见 [`docs/介绍.md`](./docs/介绍.md)。协议：[MIT](./LICENSE)。
