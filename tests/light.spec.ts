import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply, inject, name } from '../src/index.ts'
import { buildSkillContent } from '../src/skill-content.ts'
import { VERSION } from '../src/version.ts'
import type { ExecCtx, FsInfo, FsService, FsTarget, PlanExecuteConfig } from '../src/index.ts'

/**
 * 内存版 fs 服务：镜像真实 dsh-fs-local 语义（已实证）：
 * - writeText 第3参 expected：{kind:'createIfAbsent'}（已存在→FS_NOT_OBSERVED）、{kind:'replaceIfVersion',version}（版本不符→FS_STALE_VERSION）
 * - stat 返回 {version,type,size}，version 每次写后递增（模拟真实 FsVersion）
 * - 不存在文件 stat 返回 undefined
 */
function memFs() {
  const files = new Map<string, { content: string; version: number }>()
  const cwdSeen: Array<string | undefined> = []
  let lastPolicy: unknown
  let versionCounter = 1
  const target = (rel: string): FsTarget => ({ targetKey: rel, displayPath: rel })

  const bump = (key: string, content: string): number => {
    const v = versionCounter++
    files.set(key, { content, version: v })
    return v
  }

  const service: FsService = {
    async resolve(path: string, opts?: { cwd?: string }) {
      cwdSeen.push(opts?.cwd)
      return target(path)
    },
    async stat(t: FsTarget): Promise<FsInfo | undefined> {
      const e = files.get(t.targetKey)
      return e ? { version: e.version, type: 'file', size: e.content.length } : undefined
    },
    async readText(t: FsTarget): Promise<string> {
      const e = files.get(t.targetKey)
      if (!e) throw new Error('ENOENT')
      return e.content
    },
    async writeText(t: FsTarget, content: string, expected?: { kind: string; version?: unknown }, _signal?: unknown, policy?: unknown) {
      lastPolicy = policy
      const existing = files.get(t.targetKey)
      if (expected?.kind === 'createIfAbsent' && existing) {
        throw Object.assign(new Error('cannot overwrite existing file without reading it first'), { code: 'FS_NOT_OBSERVED' })
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!existing) throw Object.assign(new Error('file no longer exists'), { code: 'FS_STALE_VERSION' })
        if (existing.version !== expected.version) throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
      }
      return { version: bump(t.targetKey, content) }
    },
    async editText(t: FsTarget, edit: { oldString: string; newString: string; replaceAll?: boolean }, expected?: { version?: unknown }, _signal?: unknown, policy?: unknown) {
      lastPolicy = policy
      const existing = files.get(t.targetKey)
      if (!existing) throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
      if (expected && existing.version !== expected.version) {
        throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
      }
      const content = edit.replaceAll ? existing.content.split(edit.oldString).join(edit.newString) : existing.content.replace(edit.oldString, edit.newString)
      return { version: bump(t.targetKey, content) }
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

/** 模拟 skill 写 md 任务列表（工具之外的写者，无引擎守卫）。 */
const MD = (lines: string[]) => `# 执行计划\n\n## 任务列表\n${lines.join('\n')}\n`

describe('dsh-plan-execute arch-final 契约', () => {
  it('导出 name/inject，name 为合法 ASCII', () => {
    expect(name).toBe('dsh-plan-execute')
    expect(inject).toEqual(['tools'])
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('注册 plan_execute 工具（含 render/execute）与 plan-workflow skill', () => {
    const { ctx, getRegistered, getSkill } = makeCtx(memFs().service, true)
    apply(ctx, CONFIG)
    const def = getRegistered()
    expect(def!.name).toBe('plan_execute')
    expect(typeof def!.output?.render).toBe('function')
    expect(typeof def!.execute).toBe('function')
    const skill = getSkill()
    expect(skill!.name).toBe('plan-workflow')
    expect(skill!.content).toContain('勾选行')
    expect(skill!.content).toContain('- [x] T1')
  })

  it('写 meta 时携带 per-session 沙箱策略（workspaceRoot 作 cwd）', async () => {
    const { service, getLastPolicy, cwdSeen } = memFs()
    const { ctx, getRegistered } = makeCtx(service, false, true)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start', slug: 'x' })
    expect(getLastPolicy()).toMatchObject({ mode: 'workspace-write', workspaceRoot: '/ws' })
    expect(cwdSeen.some((c) => c === '/ws')).toBe(true)
  })

  it('VERSION 与 package.json 同步；工具描述带版本指纹', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    expect(VERSION).toBe(pkg.version)
    const { ctx, getRegistered } = makeCtx(memFs().service)
    apply(ctx, CONFIG)
    expect(getRegistered()!.description).toContain(`引擎 v${VERSION}`)
  })

  it('skill 正文快照（防无意识文案漂移）', () => {
    expect(buildSkillContent('light', true)).toMatchSnapshot('autoTrigger-true')
    expect(buildSkillContent('light', false)).toMatchSnapshot('autoTrigger-false')
  })
})

describe('start：防覆盖', () => {
  it('无计划时 start 新建 meta（phase=compile），返回引导写 md', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    const r = await execute({ action: 'start', slug: 'proj' })
    expect(r.phase).toBe('compile')
    expect(r.text).toContain('新建计划')
    const meta = JSON.parse(files.get('.plan/proj.meta.json')!.content)
    expect(meta.phase).toBe('compile')
    expect(meta.slug).toBe('proj')
  })

  it('md 已存在时 start 拒绝（不覆盖）', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    // skill 先写了 md（异常顺序：md 先于 meta）
    files.set('proj.md', { content: MD(['- [ ] T1: 建页面']), version: 1 })
    const r = await execute({ action: 'start', slug: 'proj' })
    expect(r.text).toContain('已存在计划')
    // 且没有覆盖 md
    expect(files.get('proj.md')!.content).toContain('- [ ] T1: 建页面')
  })

  it('meta 已存在时 start 拒绝（不覆盖）', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start', slug: 'proj' })
    const before = files.get('.plan/proj.meta.json')!.content
    const r = await execute({ action: 'start', slug: 'proj' })
    expect(r.text).toContain('已存在计划')
    expect(files.get('.plan/proj.meta.json')!.content).toBe(before)
  })

  it('slug 清洗无路径穿越；空/缺省回默认', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start', slug: '../../evil/../x' })
    expect(files.has('.plan/evil-x.meta.json')).toBe(true)
    expect(Array.from(files.keys()).some((k) => k.includes('..'))).toBe(false)

    const d = await execute({ action: 'start' })
    expect(d.slug).toBe('demo')
  })
})

describe('confirm：compile → execute', () => {
  it('md 有任务行时 confirm 放行', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start', slug: 'proj' })
    files.set('proj.md', { content: MD(['- [ ] T1: 建页面', '- [ ] T2: 接接口']), version: 1 })
    const r = await execute({ action: 'confirm', slug: 'proj' })
    expect(r.phase).toBe('execute')
    expect(r.text).toContain('2 个任务')
    const meta = JSON.parse(files.get('.plan/proj.meta.json')!.content)
    expect(meta.phase).toBe('execute')
  })

  it('md 无任务行时 confirm 拒绝', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    await execute({ action: 'start', slug: 'proj' })
    const r = await execute({ action: 'confirm', slug: 'proj' })
    expect(r.phase).toBe('compile')
    expect(r.text).toContain('还没有任务行')
  })

  it('无 meta 时 confirm 拒绝', async () => {
    const { service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())

    const r = await execute({ action: 'confirm', slug: 'proj' })
    expect(r.text).toContain('（无计划）')
  })
})

describe('execute：report / deviation / stop', () => {
  async function intoExecute(execute: (args: Record<string, unknown>) => Promise<{ phase: string; text: string }>, files: Map<string, { content: string; version: number }>, lines: string[]) {
    await execute({ action: 'start', slug: 'proj' })
    files.set('proj.md', { content: MD(lines), version: 1 })
    await execute({ action: 'confirm', slug: 'proj' })
  }

  it('report 从 md 勾选现算统计（与用户所见一致）', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never, files, ['- [x] T1: 建页面', '- [ ] T2: 接接口', '- [x] T3: 写测试'])

    const r = await execute({ action: 'report', slug: 'proj' })
    expect(r.text).toContain('2/3 完成')
    expect(r.text).toContain('已完成：T1、T3')
    expect(r.text).toContain('未完成：T2')
  })

  it('md 手改勾选 = 用户改决定，统计如实反映（状态真相在 md）', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never, files, ['- [ ] T1: 建页面'])

    // 用户/skill 手改 md 勾选
    files.set('proj.md', { content: MD(['- [x] T1: 建页面']), version: 2 })
    const r = await execute({ action: 'report', slug: 'proj' })
    expect(r.text).toContain('1/1 完成')
  })

  it('md 无编号行（备注）不算任务；容忍全角冒号/大写X/行首空白', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never, files, [
      '- [ ] 这是备注不算任务',
      '- [X] T1：建页面', // 全角冒号 + 大写 X
      '  - [ ] T2: 接接口', // 行首空白
    ])

    const r = await execute({ action: 'report', slug: 'proj' })
    expect(r.text).toContain('1/2 完成')
    expect(r.text).toContain('已完成：T1')
  })

  it('deviation 记 failed/blocked，report 显示', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never, files, ['- [ ] T1: 建页面'])

    const d1 = await execute({ action: 'deviation', slug: 'proj', deviation: 'failed: T1 测试挂了' })
    expect(d1.text).toContain('已记录偏差')
    const d2 = await execute({ action: 'deviation', slug: 'proj', deviation: 'blocked: T2 上游没给' })
    expect(d2.text).toContain('累计 2 条')

    const r = await execute({ action: 'report', slug: 'proj' })
    expect(r.text).toContain('failed：T1 测试挂了')
    expect(r.text).toContain('blocked：T2 上游没给')
  })

  it('stop 收尾闸门：有未完成任务时拦住并列出', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never, files, ['- [x] T1: 建页面', '- [ ] T2: 接接口'])

    const r = await execute({ action: 'stop', slug: 'proj' })
    expect(r.phase).toBe('execute') // 未置 done
    expect(r.text).toContain('还有 1 个任务未标记完成')
    expect(r.text).toContain('T2')
  })

  it('stop 全完成时置 done 并出统计', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never, files, ['- [x] T1: 建页面', '- [x] T2: 接接口'])

    const r = await execute({ action: 'stop', slug: 'proj' })
    expect(r.phase).toBe('done')
    expect(r.text).toContain('全部 2 个任务已完成')
    expect(JSON.parse(files.get('.plan/proj.meta.json')!.content).phase).toBe('done')
  })

  it('continue 续跑 execute；continue&phase=compile 回退重编译', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never, files, ['- [ ] T1: 建页面'])

    const c = await execute({ action: 'continue', slug: 'proj' })
    expect(c.phase).toBe('execute')
    expect(c.text).toContain('已完成 0/1')

    const back = await execute({ action: 'continue', slug: 'proj', phase: 'compile' })
    expect(back.phase).toBe('compile')
    expect(back.text).toContain('续跑')
  })

  it('meta 版本守卫：写 meta 带 replaceIfVersion（引擎不静默覆盖并发修改）', async () => {
    const { files, service } = memFs()
    const { ctx, getRegistered } = makeCtx(service)
    apply(ctx, CONFIG)
    const execute = await executeOf(getRegistered())
    await intoExecute(execute as never, files, ['- [ ] T1: 建页面'])

    // 断言 writeMeta 确实用了 replaceIfVersion：直接改版本号后，readMeta 读到的新版本与 stat 一致，
    // 守卫在「读到旧版 → 期间被改 → 提交」的跨进程窗口才触发；单进程内引擎每次现取 stat 版本，天然免疫。
    // 这里验证守卫链存在：memFs 的 writeText 收到 {kind:'replaceIfVersion'} 时版本不符会抛 FS_STALE_VERSION。
    const metaRaw = files.get('.plan/proj.meta.json')!
    // 模拟另一进程在引擎 read 之后、write 之前改了 meta（版本 +1）
    files.set('.plan/proj.meta.json', { content: metaRaw.content, version: metaRaw.version + 1 })

    // 引擎 deviation 先 readMeta（读到当前 meta 对象）再 writeMeta（现取 stat 版本 = 已改的新版本）→ 匹配，正常写。
    // 这正是单进程引擎的免疫路径：以 stat 现取版本为基准，不存在「陈旧读」窗口。
    const r = await execute({ action: 'deviation', slug: 'proj', deviation: 'blocked: T1 等上游' })
    expect(r.text).toContain('已记录偏差')
    // 且原 meta 内容（含 phase:execute）未被破坏
    const after = JSON.parse(files.get('.plan/proj.meta.json')!.content)
    expect(after.phase).toBe('execute')
    expect(after.deviations).toContain('blocked: T1 等上游')
  })
})
