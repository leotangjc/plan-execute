# dsh-plan-execute 结构设计（双模式版，main 当前形态）

> 单包双引擎：light（简化，缺省）+ heavy（完整防御），由 config.mode 分发（见 §1-§6 light 为主、§7 起含双引擎说明）。设计经 heavy-reasoning 协议（3 生成 + 批判 + 破拆 + 父代理抽查）收敛，并基于真实 DSH fs 源码实证。

## 1. 一句话

一个包 = 一个「闸门与统计」工具 `plan_execute` + 一个「大脑」skill `plan-workflow`，按 `config.mode` 选引擎。
light 模式：任务状态 = 项目 md 的勾选行；引擎只读 md、只写 meta，绝不覆盖已有计划。
heavy 模式：完整状态机（grill→compile→execute→done）+ 两层确认 + 六字段 + 审计 + 活动指针。

## 2. 职责边界（谁写什么——核心）

| 实体 | 写什么 | 用什么保证 |
| --- | --- | --- |
| skill `plan-workflow` | `<slug>.md`：任务列表（`- [x] T1: 标题`）+ 执行记录 | 模型工具写（无原子守卫，可接受——md 不是机器真相） |
| 引擎 `plan_execute` | `.plan/<slug>.meta.json`：phase + deviations | writeText + `replaceIfVersion` 版本守卫（已实证真实签名） |
| 引擎只读 | `<slug>.md` 任务行（`TASK_LINE` 行首锚定解析） | 只读无守卫 |

**单一写者原则**：md 的写者只有 skill（引擎永不写 md）；meta 的写者只有引擎（skill 永不写 meta）。两端互不越界，杜绝「双写竞态」（R2 死法）。

**状态真相 = md 勾选行**：`[x]` = 完成、`[ ]` = 未完成。用户看 md 即知进度；skill 忘勾 = 用户看得见 + 收尾闸门阻塞（R1「忘 record」死法结构性免疫）。

## 3. 文件契约（每项目 ≤2 文件）

```
<slug>.md                # 用户看进度的仪表盘 + skill 工作台（人读，可交付）
# 执行计划
## 任务列表
- [ ] T1: 建页面          # 任务行格式：- [ ]/[x] + 空格 + T编号 + 冒号 + 标题
- [x] T2: 接接口          # 容忍全角冒号/大写 X/行首空白；无编号的备注行不算任务
.plan/<slug>.meta.json   # 引擎写：phase + slug + updatedAt + deviations[]
                         # deviations 元素形如 "failed: T1 原因" / "blocked: T2 原因" / 自由文本
```

- 无 `.current`（slug 必带，不带落默认 plan）
- 无 `.log`（审计非需求）
- 无锁文件（跨进程写保护：md 靠「同一计划单会话」约定；meta 靠 replaceIfVersion 版本守卫）
- 无 schema 版本（新格式起步）

## 4. 状态机（4 态，phase 存 meta）

```
start（compile）→ skill 写 md 任务列表 → confirm（校验 ≥1 任务行 → execute）
→ 逐任务执行（skill 改 [x] / deviation 记失败卡住）→ stop（收尾闸门 → done）
→ continue 续跑；continue&phase=compile 回退重编译
```

- **grill 不落盘**（问答纯对话；确认的决策由 skill 固化成任务列表）
- **start 防覆盖**：md 或 meta 任一存在即拒（不依赖顺序假设）；createIfAbsent 原子兜底（内核 link EEXIST，跨进程真原子，已实证）
- **confirm 守门**：md 无任务行不放行
- **stop 收尾闸门**：未勾任务列出阻塞、不置 done——静默缺失结构性不可能

## 5. 报告（report）

- 进度 = 数 md 勾选行（`done/total`，永远与用户看见的 md 一致）
- failed/blocked = 解析 meta.deviations 的 `类型: 文本` 前缀
- 无任务 → 提示先写 md

## 6. 参数契约

| 参数 | 含义 |
| --- | --- |
| action | start / confirm / deviation / report / stop / continue |
| slug | 项目标识（每次必带；清洗 [A-Za-z0-9_-]，缺省 plan） |
| deviation | 偏差文本（`failed: T1 原因` / `blocked: T2 原因` / 自由文本） |
| phase | 可选，continue 回退指定阶段 |

插件配置：`autoTrigger: boolean`（缺省 true）。

## 7. 已实证的真实 fs 语义（设计依据，非假设）

- writeText 原子写（temp+rename），第 3 参 expected 支持 `{kind:'createIfAbsent'}`（已存在→FS_NOT_OBSERVED）与 `{kind:'replaceIfVersion', version}`（版本不符→FS_STALE_VERSION）
- editText 原子读改写 + 裸 `{version}` 版本检查
- stat 返回 `{version, type, size}`，version 由 stat 现算（重启可续）
- resolve 永不返回 undefined；不存在由 stat 探测
- withLock 进程内（跨进程无效）→ 引擎写 meta 用版本守卫而非锁
- **模型工具层不暴露 createIfAbsent/replaceIfVersion 参数**（writeText 第 3 参来自 waterfall intent）→ 引擎是唯一能拿到 fs 级硬原子守卫的路径（「引擎值得存在」的实证依据）

## 8. 测试（71 个）

- **light 套件**（20 个）：memFs 镜像真实 fs 语义（createIfAbsent/replaceIfVersion/stat 版本号）。覆盖：契约、防覆盖（md/meta 双检查）、confirm 守门、report 现算、md 手改=用户决定、备注行不算任务、deviation 类型前缀、收尾闸门、stop 置 done、continue 回退、版本守卫链、skill 快照。
- **heavy 套件**（51 个）：完整状态机、两层确认、六字段、backlog 守门、停止词变体、防御设计、显式状态机表。

## 9. 明确不做

- 引擎不写 md、不解析 md 除任务行外的内容、不替 skill 记任务状态
- 不做两层确认/六字段/backlog 守门/审计日志/活动指针/损坏备份（均为 main 完整版机制，arch-final 砍掉）
- 不做多会话并发写 md 防护（文档化「同一计划单会话」）
- 不做计划质量校验（依赖无环等，归 skill）

## 10. 已知限制（接受项）

- skill 忘勾 → 进度少一项 + 收尾闸门拦（可见，不静默）
- 计划阶段漏写任务 → 闸门查不到（靠用户看 md 发现）
- 跨进程并发跑同计划 → md 后写覆盖先写（文档化限制）
- 彻底重来 → 删 md + meta 或换 slug
