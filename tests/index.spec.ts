import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.ts'
import type { ExecCtx, FsService, FsTarget, PlanExecuteConfig } from '../src/index.ts'

/** 内存版 fs 服务：镜像真实服务语义（缺失 readText 抛错、stat 返回 undefined）。 */
function memFs() {
  const files = new Map<string, string>()
  const cwdSeen: Array<string | undefined> = []
  let lastPolicy: unknown
  const target = (rel: string): FsTarget => ({ targetKey: rel, displayPath: rel })
  const service: FsService = {
    async resolve(path: string, opts?: { cwd?: string }) {
      cwdSeen.push(opts?.cwd)
      return target(path)
    },
    async stat(t: FsTarget) {
      return files.has(t.targetKey) ? { version: 1 } : undefined
    },
    async readText(t: FsTarget) {
      const v = files.get(t.targetKey)
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    async writeText(t: FsTarget, content: string, _intent?: unknown, _signal?: unknown, policy?: unknown) {
      files.set(t.targetKey, content)
      lastPolicy = policy
      return { version: 2 }
    },
  }
  return { files, service, cwdSeen, getLastPolicy: () => lastPolicy }
}

function makeCtx(service: FsService, withSkills = false, withPolicy = false) {
  let registered: {
    name?: string
    output?: { render?: (...a: unknown[]) => unknown }
    execute?: (args: unknown, exec: ExecCtx) => Promise<unknown>
  } | null = null
  let registeredSkill: { name?: string; description?: string; content?: string; source?: string } | null = null
  const tools = {
    register(definition: typeof registered) {
      registered = definition
      return () => {}
    },
  }
  const skills = {
    register(skill: typeof registeredSkill) {
      registeredSkill = skill
      return () => {}
    },
  }
  const policySvc = {
    resolve() {
      return { mode: 'workspace-write', workspaceRoot: '/ws' }
    },
  }
  const ctx = {
    get(name: string) {
      if (name === 'fs') return service
      if (name === 'tools') return tools
      if (name === 'skills' && withSkills) return skills
      if (name === 'sandboxPolicy' && withPolicy) return policySvc
      return undefined
    },
    effect(cb: () => unknown) {
      return cb
    },
    emit() {},
    waterfall(_name: string, ...args: unknown[]) {
      const fb = args[args.length - 1]
      return typeof fb === 'function' ? fb() : undefined
    },
  }
  return { ctx: ctx as never, getRegistered: () => registered, getSkill: () => registeredSkill }
}

const EXEC: ExecCtx = { agent: { session: { header: { cwd: '/ws' } } } }
const CONFIG: PlanExecuteConfig = { defaultSlug: 'demo' }

async function executeOf(registered: NonNullable<ReturnType<typeof makeCtx>['getRegistered']>) {
  return (args: Record<string, unknown>) => registered!.execute!(args, EXEC) as Promise<{
    text: string
    nextAction: string
    phase: string
    slug: string
  }>
}

describe('dsh-plan-execute 插件契约', () => {
  it('导出 name/inject，name 为合法 ASCII', () => {
    expect(name).toBe('dsh-plan-execute')
    expect(inject).toEqual(['tools'])
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('注册 plan_execute 工具，带 output.render 与 execute', () => {
    const { ctx, getRegistered } = makeCtx(memFs().service)
    apply(ctx, CONFIG)
    const def = getRegistered()
    expect(def!.name).toBe('plan_execute')
    expect(typeof def!.output?.render).toBe('function')
    expect(typeof def!.execute).toBe('function')
  })

  it('注册 plan-workflow skill（随包打包）', () => {
    const { ctx, getSkill } = makeCtx(memFs().service, true)
    apply(ctx, CONFIG)
    const skill = getSkill()
    expect(skill!.name).toBe('plan-workflow')
    expect(skill!.source).toBe('bundled')
    expect(skill!.content).toContain('拷问决策')
    expect(skill!.content).toContain('plan_execute')
    // 抽离自 src/skill-content.ts 后仍须保留：默认触发文案 + 执行状态/偏差展示-only 契约
    expect(skill!.content).toContain('默认进入本流程')
    expect(skill!.content).toContain('统计只来自 .plan/<slug>.meta.json 快照')
    expect(skill!.content).toContain('stop / done')
  })

  it('无 skills 服务时工具仍可注册', () => {
    const { ctx, getRegistered, getSkill } = makeCtx(memFs().service, false)
    apply(ctx, CONFIG)
    expect(getRegistered()!.name).toBe('plan_execute')
    expect(getSkill()).toBeNull()
  })

  it('写文件时携带 per-session 沙箱策略（workspaceRoot 作 cwd）', async () => {
    const { service, getLastPolicy, cwdSeen } = memFs()
    const { ctx, getRegistered } = makeCtx(service, false, true)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start', slug: 'x' })
    expect(getLastPolicy()).toMatchObject({ mode: 'workspace-write', workspaceRoot: '/ws' })
    expect(cwdSeen.some((c) => c === '/ws')).toBe(true)
  })

  it('非 start 漏传 slug 时兜底用最近一次计划（活动 slug 指针）', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG) // defaultSlug 'demo'
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start', slug: 'abc' }) // 建立 abc 并写指针
    const r = await execute({ action: 'answer', question: 'Q1?', answer: 'A' }) // 漏了 slug
    expect(r.slug).toBe('abc')
    expect(files.has('.grill/abc.md')).toBe(true)
  })

  it('指针失效（所指计划无状态）时回默认，不静默用过期指针', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start', slug: 'staleplan' }) // 指针=staleplan，有状态
    const r = await execute({ action: 'report' })
    expect(r.slug).toBe('staleplan')

    files.delete('.grill/staleplan.md')
    files.delete('.plan/staleplan.meta.json')
    const r2 = await execute({ action: 'report' }) // 状态没了 → 回默认 demo
    expect(r2.slug).toBe('demo')
  })
})

describe('grill 阶段', () => {
  it('start 写骨架与 meta，用会话工作目录解析路径', async () => {
    const { files, service, cwdSeen } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    const s1 = await execute({ action: 'start' })
    expect(s1.phase).toBe('grill')
    expect(files.get('.grill/demo.md')).toContain('## Confirmed Decisions')
    expect(files.get('.plan/demo.meta.json')).toContain('"grill"')
    expect(cwdSeen.some((c) => c === '/ws')).toBe(true)
  })

  it('answer 无 question 时提示喂题（无固定题库）', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start' })
    const r = await execute({ action: 'answer', answer: '随便答' })
    expect(r.text).toContain('question 参数')
  })

  it('question+answer 落盘成对 Q/A', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start' })
    const r = await execute({ action: 'answer', question: '这个库 license 允许商用吗？', answer: 'MIT，允许' })
    expect(r.text).toContain('已记录')
    expect(files.get('.grill/demo.md')).toContain('license 允许商用')
    expect(files.get('.grill/demo.md')).toContain('MIT，允许')
  })

  it('「结束」自动衔接进 compile', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start' })
    const end = await execute({ action: 'answer', answer: '结束' })
    expect(end.phase).toBe('compile')
    expect(end.text).toContain('编译计划')
  })

  it('「暂停功能很重要」含停止词子串但不终止', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start' })
    const notStop = await execute({ action: 'answer', question: '还有什么风险？', answer: '暂停功能很重要' })
    expect(notStop.phase).toBe('grill')
  })
})

describe('compile 阶段', () => {
  it('两层确认后自动衔接进 execute', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start' })
    await execute({ action: 'answer', answer: '结束' }) // grill -> compile（自动）

    const layer1 = await execute({ action: 'answer', answer: '里程碑 M1/M2' })
    expect(layer1.phase).toBe('compile')
    expect(layer1.text).toContain('第二层')

    const layer2 = await execute({ action: 'answer', answer: '任务 T1/T2，验收标准' })
    expect(layer2.phase).toBe('execute')
    expect(files.get('.plan/demo.md')).toContain('结构确认')
    expect(files.get('.plan/demo.md')).toContain('细节确认')
  })

  it('缺 .grill 时拒绝进入 compile', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    const r = await execute({ action: 'start', phase: 'compile' })
    expect(r.text).toContain('请先完成「拷问决策」')
  })

  it('section+content 写进计划六字段', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start' })
    await execute({ action: 'answer', answer: '结束' })
    await execute({ action: 'answer', section: '任务列表', content: '- T1 建页面\n- T2 接接口' })
    const plan = files.get('.plan/demo.md')!
    expect(plan).toContain('## 任务列表')
    expect(plan).toContain('- T1 建页面')
  })
})

describe('execute 阶段', () => {
  async function intoExecute(execute: (args: Record<string, unknown>) => Promise<{ phase: string; text: string }>) {
    await execute({ action: 'start' })
    await execute({ action: 'answer', answer: '结束' })
    await execute({ action: 'answer', answer: '结构 OK' })
    await execute({ action: 'answer', answer: '细节 OK' })
  }

  it('record 同一任务多次记录按最新状态计数；action=report 出报告', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never)

    await execute({ action: 'answer', record: 'T1 doing' })
    await execute({ action: 'answer', record: 'T1 done' })
    await execute({ action: 'answer', record: 'T2 failed: 测试挂了' })

    const r = await execute({ action: 'report' })
    expect(r.text).toContain('done: 1')
    expect(r.text).toContain('doing: 0')
    expect(r.text).toContain('failed: 1')
    expect(r.text).toContain('T2')
  })

  it('blocked 支持带上游原因；deviation 记入报告', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never)

    await execute({ action: 'answer', record: 'T2 blocked: 上游 T1' })
    await execute({ action: 'answer', deviation: '临时把验收标准从 A 改成 B' })

    const r = await execute({ action: 'report' })
    expect(r.text).toContain('blocked: 1')
    expect(r.text).toContain('上游 T1')
    expect(r.text).toContain('deviations: 1')
    expect(r.text).toContain('临时把验收标准从 A 改成 B')
  })

  it('report 优先读 meta.tasks 结构化快照（md 手改执行状态不污染统计）', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never)

    await execute({ action: 'answer', record: 'T1 done' })
    await execute({ action: 'answer', record: 'T2 doing' })
    expect(files.get('.plan/demo.meta.json')).toContain('"tasks"')

    // 手改 md 执行状态节加一条假 done，结构化路径应免疫
    const plan = files.get('.plan/demo.md')!
    files.set('.plan/demo.md', plan.replace('## 执行状态', '## 执行状态\n- X done'))

    const r = await execute({ action: 'report' })
    expect(r.text).toContain('done: 1')
    expect(r.text).toContain('doing: 1')
    expect(r.text).not.toContain('X')
  })

  it('「结束」置 done；start 检测到已有计划返回冲突提示（不覆盖）', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never)

    const done = await execute({ action: 'answer', answer: '结束' })
    expect(done.phase).toBe('done')

    const again = await execute({ action: 'start' })
    expect(again.text).toContain('已存在计划')
    expect(again.phase).toBe('done')
  })
})

describe('start 不接管已有计划', () => {
  it('同 slug 已有状态时 start 返回冲突提示，且不覆盖文件', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start' })
    await execute({ action: 'answer', question: '决策树？', answer: 'ABC' })
    const before = files.get('.grill/demo.md')

    const r = await execute({ action: 'start' })
    expect(r.text).toContain('已存在计划')
    expect(files.get('.grill/demo.md')).toBe(before)
  })

  it('换新 slug 可正常新建', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start' })
    const r = await execute({ action: 'start', slug: 'newproj' })
    expect(r.phase).toBe('grill')
    expect(files.has('.grill/newproj.md')).toBe(true)
  })
})

describe('slug 清洗', () => {
  it('清洗为安全标识，无路径穿越', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start', slug: '../../evil/../x' })
    expect(files.has('.grill/evil-x.md')).toBe(true)
    expect(Array.from(files.keys()).some((k) => k.includes('..'))).toBe(false)
  })
})

describe('v2.1 防碰撞与语义', () => {
  it('纯中文 slug 转 plan-短哈希且不同名不冲突；空/缺省回默认', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG) // defaultSlug: 'demo'
    const execute = await executeOf(getRegistered())

    const a = await execute({ action: 'start', slug: '记账项目' })
    expect(a.slug).toMatch(/^plan-[0-9a-f]{6,8}$/)

    const b = await execute({ action: 'start', slug: '任务安排' })
    expect(b.slug).not.toBe(a.slug)

    const d = await execute({ action: 'start' })
    expect(d.slug).toBe('demo')
  })

  it('grill 中「暂停/停」停留本阶段，「结束」才推进', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start' })
    const paused = await execute({ action: 'answer', answer: '暂停一下' })
    expect(paused.phase).toBe('grill')
    expect(paused.text).toContain('暂停')

    const end = await execute({ action: 'answer', answer: '结束' })
    expect(end.phase).toBe('compile')
  })

  it('Unresolved Backlog 非空时「结束」暂缓编译；清空后可进', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start' })
    // 无空格行也计入未决（防守门绕过）
    files.set('.grill/demo.md', files.get('.grill/demo.md')! + '-待确认项\n')

    const blocked = await execute({ action: 'answer', answer: '结束' })
    expect(blocked.phase).toBe('compile')
    expect(blocked.text).toContain('暂缓')
    expect(files.has('.plan/demo.md')).toBe(false)

    files.set('.grill/demo.md', files.get('.grill/demo.md')!.replace('-待确认项\n', '- [x] 待确认项（已处理）\n'))
    const ok = await execute({ action: 'answer', answer: '结束' })
    expect(ok.text).toContain('编译计划')
    expect(files.has('.plan/demo.md')).toBe(true)
  })

  it('停止词变体：够了/够了够了 触发推进（回归防护）', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    let n = 0
    for (const w of ['够了', '够了够了', '结束了']) {
      n += 1
      await execute({ action: 'start', slug: `t${n}` })
      const r = await execute({ action: 'answer', answer: w })
      expect(r.phase).toBe('compile')
    }
  })

  it('暂停变体停留本阶段（回归防护）', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start', slug: 'p1' })
    for (const w of ['暂停', '暂停一下', '先停一下', '停']) {
      const r = await execute({ action: 'answer', answer: w })
      expect(r.phase).toBe('grill')
    }
    const end = await execute({ action: 'answer', answer: '结束' })
    expect(end.phase).toBe('compile')
  })

  it('完整版契约：report 只认 meta 快照，md 手写状态/偏差行一律不计入', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    // md 里有手写状态行 + 偏差节伪行，但 meta 只有 tasks 快照
    const plan = [
      '# 执行计划: demo',
      '## 任务列表',
      '## 执行状态',
      '- T1 done',
      '- X done',
      '## 偏差记录',
      '- 手写偏差：不算',
    ].join('\n')
    files.set('.plan/demo.md', plan)
    files.set(
      '.plan/demo.meta.json',
      JSON.stringify({ phase: 'execute', slug: 'demo', tasks: { T1: { status: 'done' } }, deviations: ['真实偏差'] }),
    )

    const r = await execute({ action: 'report' })
    expect(r.text).toContain('done: 1') // 只计 meta.tasks，md 里的 X done 不计
    expect(r.text).not.toContain('X')
    expect(r.text).toContain('deviations: 1') // 只计 meta.deviations，md 手写偏差不计
    expect(r.text).toContain('真实偏差')
    expect(r.text).not.toContain('手写偏差')
  })

  it('老计划（meta 无快照）report 显示暂无状态而非解析 md', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    files.set('.plan/demo.md', ['# 执行计划: demo', '## 执行状态', '- T1 done'].join('\n'))
    files.set('.plan/demo.meta.json', JSON.stringify({ phase: 'execute', slug: 'demo' }))

    const r = await execute({ action: 'report' })
    expect(r.text).toContain('尚无执行状态记录')
  })

  it('Q 编号只数带数字的 Q 行，防「- Q：转述」污染', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start' })
    files.set(
      '.grill/demo.md',
      files.get('.grill/demo.md')!.replace('## Constraints & Risks', '- Q：转述问题\n## Constraints & Risks'),
    )
    const r = await execute({ action: 'answer', question: '第一个问题', answer: '答复A' })
    expect(files.get('.grill/demo.md')).toContain('- Q1：第一个问题')
  })
})
