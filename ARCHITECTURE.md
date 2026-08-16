# dsh-plan-execute 结构设计（冻结版）

## 1. 一句话

一个包 = 一个「记账本」工具 `plan_execute` + 一个「大脑」skill `plan-workflow`。
一次 `dsh plugin add` 装齐；skill 决定「怎么想」，工具决定「记到哪、走到哪」。

## 2. 分层与职责

| 层 | 实体 | 职责 | 明确不负责 |
| --- | --- | --- | --- |
| 大脑 | skill `plan-workflow`（注册进 skills 服务，随包发布） | 读代码、追问、抓矛盾、生成计划、判断验收、执行纪律、切阶段 | 落盘、记状态 |
| 记账本 | 工具 `plan_execute`（状态机，Host） | 阶段指针、Q/A 记录、计划六字段、任务状态、里程碑报告、断点续跑 | 思考、判断 |

铁律：工具只接收「最终确认的内容」；所有「改/拒绝/重问/抓矛盾」都在 skill↔用户 之间完成，绝不进工具。

## 3. 工具（状态机）

- 阶段：grill → compile → execute → done（`start` 续跑；`done`/无记录才重开）
- 动作：start / answer / continue / report / stop
- 喂数据口子：question · section+content · record · deviation · answer · phase · slug
- 子状态（存 `.plan/<slug>.meta.json`）：phase / compileLayer / updatedAt

阶段衔接（自动）：grill 用户说「结束」→ 工具切 compile 并直接返回 compile 开场；
compile 第二层确认 → 工具切 execute 并直接返回 execute 开场；execute「结束」→ done（终态）。
`continue` 仅用于断点续跑。

报告：唯一入口 `action=report`（execute 阶段输出里程碑报告，其它阶段输出阶段指针）。

## 4. 文件格式契约

```
.grill/<slug>.md        三段骨架：Confirmed Decisions / Constraints & Risks / Unresolved Backlog
                        Q/A 对由工具记（编号）；另两段由主 agent 直接 write/edit 写
.plan/<slug>.md         六字段（任务列表/依赖图/验收标准/风险与假设/未决项映射/里程碑）
                        + 确认记录 + 执行状态 + 偏差记录
                        六字段用 section+content 写；确认记录/执行状态/偏差记录由工具写
.plan/<slug>.meta.json  阶段指针（机器读）
```

不对称原则：交给别人/别的 agent 消费的文件（`.plan` 六字段）需要格式强约束 → 工具写；
内部工作笔记（`.grill` 另两段）格式可松 → 主 agent 直接写。

## 5. 参数契约（公共 API，冻结；改动 = major bump）

| 参数 | 含义 | 阶段 |
| --- | --- | --- |
| action | start/answer/continue/report/stop | 全程 |
| phase | 指定阶段（grill/compile/execute） | 全程 |
| slug | 项目标识（清洗为 [A-Za-z0-9_-]，缺省 plan） | 全程 |
| answer | 用户对上一题的最终答复 | grill/compile/execute |
| question | 主 agent 提的问题（本次 answer 对应） | grill |
| section + content | 写计划六字段 | compile/execute |
| record | 任务状态「任务ID 状态 [原因]」 | execute |
| deviation | 记录一条与计划的偏差 | execute |

## 6. skill `plan-workflow` 内容大纲

1. Role（编排者 + 主执行者，用户是唯一决策者）
2. 触发词
3. 铁律（工具只收最终确认内容；永不替用户决策；永不改已确认计划）
4. 总流程 + 参数速查表
5. 阶段一 grill（读代码→一次一问→依赖序→抓矛盾→TBD 标 blocker/defer→结束）
6. 阶段二 compile（生成六字段→写盘→校验→两层确认→改只重派生）
7. 阶段三 execute（串行执行→可观察验收→record/deviation→report→停止条件）
8. 中断与修改（改文件 / phase 重置 / 删文件重来 / 改什么重确认什么）

## 7. 测试

- 工具层：状态机、自动衔接、报告、落盘、slug 清洗、record 去重、skill 注册；
- skill 正文：提示词无法单测，靠「结构审查 + 与参数契约一致性」人工核对。

## 8. 明确不做（记录在案，避免回头纠结）

- 插件不做读代码/生成计划/验收判断/执行纪律（归 skill）；
- 不内置任何题目（无固定题库，grill 必须由主 agent 用 question 喂题）；
- 不做任务级崩溃恢复、不做撤销/回滚（建议 workspace 放 git）；
- 不改用户本地三个原 skill 文件。
