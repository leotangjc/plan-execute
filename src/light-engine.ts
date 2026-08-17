/**
 * dsh-plan-execute — light 引擎（简化版 / arch-final 设计）
 * 任务状态 = md 勾选行（- [x] T1: 标题）；引擎只读 md、只写 meta，绝不覆盖。
 * 设计核心见 ARCHITECTURE.md §2-§5（heavy-reasoning 收敛 + 实证）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { buildSkillContent } from './skill-content.js'
import { VERSION } from './version.js'
import type {
  ExecCtx,
  FsService,
  FsTarget,
  Phase,
  PlanExecuteConfig,
  PlanToolDefinition,
  SandboxPolicyService,
  SkillsService,
  StepResult,
  ToolsService,
} from './types.js'


/** 任务行格式（唯一被引擎认作任务的行）：`- [x] T1: 标题`，容忍全角冒号/行首空白/X 大写。 */
const TASK_LINE = /^\s*[-*]\s+\[([ xX])\]\s+(T\d+)\s*[:：]\s*(.*)$/
const DEVIATION_PREFIX = /^(failed|blocked)\s*[:：]\s*(.*)$/
const VALID_PHASES: readonly Phase[] = ['compile', 'execute', 'done']

function mdPath(slug: string): string {
  return `${slug}.md`
}

export function applyLight(ctx: Context, _config: PlanExecuteConfig = {}) {

interface Meta {
  phase?: Phase
  slug?: string
  updatedAt?: string
  /** 偏差记录（元素形如 "failed: T1 原因" / "blocked: T2 原因" / 自由文本）。 */
  deviations?: string[]
}

  const config = {
    defaultSlug: 'plan',
    planDir: '.plan',
    autoTrigger: true,
    ..._config,
  }
  const fs = ctx.get('fs') as FsService | undefined
  if (fs === undefined) return
  const tools = ctx.get('tools') as ToolsService | undefined
  if (tools === undefined) return
  const policySvc = ctx.get('sandboxPolicy') as SandboxPolicyService | undefined

  const looseCtx = ctx as unknown as {
    emit: (name: string, ...args: unknown[]) => void
    waterfall: (name: string, ...args: unknown[]) => Promise<unknown>
  }
  const emit = (name: string, ...args: unknown[]) => looseCtx.emit(name, ...args)
  const waterfall = (name: string, ...args: unknown[]) => looseCtx.waterfall(name, ...args)

  const metaPath = (slug: string) => `${config.planDir}/${slug}.meta.json`

  const sessionCwd = (exec?: ExecCtx) => exec?.agent?.session?.header?.cwd

  async function resolvePath(rel: string, exec?: ExecCtx): Promise<FsTarget | undefined> {
    const cwd = sessionCwd(exec)
    return fs!.resolve(rel, cwd !== undefined ? { cwd } : undefined)
  }

  async function readFile(rel: string, exec?: ExecCtx): Promise<string | undefined> {
    const target = await resolvePath(rel, exec)
    if (target === undefined) return undefined
    const info = await fs!.stat(target, exec?.signal)
    if (!info) {
      emit('fs/observed', target, { kind: 'absent' }, exec)
      return undefined
    }
    const content = await fs!.readText(target, exec?.signal)
    emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    return content
  }

  /** 创建文件（原子：已存在则失败，绝不覆盖）。 */
  async function createFile(rel: string, content: string, exec?: ExecCtx): Promise<void> {
    const policy = policySvc?.resolve({ session: exec?.agent?.session })
    const cwd = policy?.workspaceRoot ?? sessionCwd(exec)
    const target = await fs!.resolve(rel, cwd !== undefined ? { cwd } : undefined)
    if (target === undefined) {
      throw new Error(`无法解析目标路径「${rel}」（可能超出工作区或沙箱拒绝）`)
    }
    const info = await fs!.stat(target, exec?.signal)
    emit(
      'fs/observed',
      target,
      info ? { kind: 'present', version: info.version } : { kind: 'absent' },
      exec,
    )
    await waterfall('fs/write-intent', target, exec, () => undefined)
    // createIfAbsent：内核级 no-replace（link EEXIST），跨进程真原子
    await fs!.writeText(target, content, { kind: 'createIfAbsent' }, exec?.signal, policy)
    emit('fs/observed', target, { kind: 'present' }, exec)
  }

  async function readMeta(slug: string, exec?: ExecCtx): Promise<Meta | undefined> {
    try {
      const raw = await readFile(metaPath(slug), exec)
      if (raw === undefined) return undefined
      const parsed = JSON.parse(raw) as Meta
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /** 写 meta（引擎唯一写者）：replaceIfVersion 版本守卫，防跨进程陈旧覆盖。 */
  async function writeMeta(slug: string, meta: Meta, exec?: ExecCtx): Promise<void> {
    const policy = policySvc?.resolve({ session: exec?.agent?.session })
    const cwd = policy?.workspaceRoot ?? sessionCwd(exec)
    const target = await fs!.resolve(metaPath(slug), cwd !== undefined ? { cwd } : undefined)
    if (target === undefined) {
      throw new Error(`无法解析目标路径「${metaPath(slug)}」（可能超出工作区或沙箱拒绝）`)
    }
    const info = await fs!.stat(target, exec?.signal)
    if (!info) {
      throw new Error(`meta 文件不存在（${metaPath(slug)}），请先用 action=start 新建计划`)
    }
    emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    await waterfall('fs/write-intent', target, exec, () => undefined)
    const next: Meta = { ...meta, slug, updatedAt: new Date().toISOString() }
    await fs!.writeText(target, JSON.stringify(next, null, 2), { kind: 'replaceIfVersion', version: info.version }, exec?.signal, policy)
    emit('fs/observed', target, { kind: 'present' }, exec)
  }

  function pickSlug(slug?: string): string {
    const raw = (slug ?? '').trim()
    const s = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    if (s) return s.slice(0, 64)
    return config.defaultSlug
  }

  /** 解析 md 任务行：返回 [{id, done, title}]；无编号的 `- [ ] 备注` 一律不算任务。 */
  function parseTasks(md: string): Array<{ id: string; done: boolean; title: string }> {
    const tasks: Array<{ id: string; done: boolean; title: string }> = []
    for (const line of md.split('\n')) {
      const m = TASK_LINE.exec(line)
      if (m) tasks.push({ id: m[2], done: m[1].toLowerCase() === 'x', title: m[3] })
    }
    return tasks
  }

  async function buildReport(slug: string, exec?: ExecCtx): Promise<string> {
    const md = (await readFile(mdPath(slug), exec)) || ''
    const tasks = parseTasks(md)
    const doneTasks = tasks.filter((t) => t.done)
    const todoTasks = tasks.filter((t) => !t.done)
    const meta = await readMeta(slug, exec)
    const deviations = Array.isArray(meta?.deviations) ? meta.deviations : []
    const failed: string[] = []
    const blocked: string[] = []
    const plain: string[] = []
    for (const d of deviations) {
      const m = DEVIATION_PREFIX.exec(d)
      if (m && m[1] === 'failed') failed.push(m[2])
      else if (m && m[1] === 'blocked') blocked.push(m[2])
      else plain.push(d)
    }
    const lines = [
      `【进度】${doneTasks.length}/${tasks.length} 完成`,
      doneTasks.length ? `- 已完成：${doneTasks.map((t) => t.id).join('、')}` : '',
      todoTasks.length ? `- 未完成：${todoTasks.map((t) => t.id).join('、')}` : '',
      failed.length ? `- failed：${failed.join('；')}` : '',
      blocked.length ? `- blocked：${blocked.join('；')}` : '',
      plain.length ? `- 偏差：${plain.join('；')}` : '',
    ].filter((l) => l !== '')
    if (tasks.length === 0) {
      return `【进度】尚无任务。请先写 md 任务列表（- [ ] T1: 标题），再 action=confirm 开始执行。`
    }
    return ['【进度报告】v' + VERSION, ...lines].join('\n')
  }

  // ============ 动作 ============
  async function actionStart(slug: string, exec?: ExecCtx): Promise<StepResult> {
    // 防覆盖：md 或 meta 任一存在即拒绝（不依赖顺序假设）
    const hasMd = (await readFile(mdPath(slug), exec)) !== undefined
    const hasMeta = (await readMeta(slug, exec)) !== undefined
    if (hasMd || hasMeta) {
      return {
        text: `检测到已存在计划「${slug}」（md ${hasMd ? '有' : '无'} / meta ${hasMeta ? '有' : '无'}）。start 不会覆盖：续跑请用 action=continue；彻底重来请先删除 ${mdPath(slug)} 与 ${metaPath(slug)}，或换一个 slug。`,
        nextAction: 'continue',
        phase: hasMeta ? (await readMeta(slug, exec))?.phase || 'compile' : 'compile',
        slug,
      }
    }
    // 原子创建 meta（跨进程兜底：即使并发 start，createIfAbsent 也只会成功一个）
    await createFile(metaPath(slug), JSON.stringify({ phase: 'compile', slug }, null, 2), exec)
    return {
      text: `【编译计划】已新建计划「${slug}」。请写 ${mdPath(slug)} 的任务列表（每行 - [ ] T1: 标题），写好后 action=confirm 开始执行。`,
      nextAction: 'confirm',
      phase: 'compile',
      slug,
    }
  }

  async function actionConfirm(slug: string, exec?: ExecCtx): Promise<StepResult> {
    const meta = await readMeta(slug, exec)
    if (!meta || meta.phase !== 'compile') {
      return { text: `当前阶段 ${meta?.phase ?? '（无计划）'}，confirm 只用于从编译进入执行。`, nextAction: 'continue', phase: meta?.phase || 'compile', slug }
    }
    const md = (await readFile(mdPath(slug), exec)) || ''
    const tasks = parseTasks(md)
    if (tasks.length === 0) {
      return { text: `md（${mdPath(slug)}）里还没有任务行。请先写任务列表（- [ ] T1: 标题），再 confirm。`, nextAction: 'confirm', phase: 'compile', slug }
    }
    await writeMeta(slug, { ...meta, phase: 'execute' }, exec)
    return {
      text: `【执行验收】开始（${tasks.length} 个任务）。逐任务执行：干完把 md 里 [ ] 改成 [x]；卡住/失败用 deviation 记（failed: T1 原因 或 blocked: T2 原因）；随时 action=report 看进度；全干完或说「结束」用 action=stop 收尾。`,
      nextAction: 'continue',
      phase: 'execute',
      slug,
    }
  }

  async function actionDeviation(slug: string, text: string, exec?: ExecCtx): Promise<StepResult> {
    const clean = text.trim().replace(/[\r\n]+/g, ' ')
    if (!clean) {
      return { text: '请提供偏差内容（deviation 参数）。', nextAction: 'continue', phase: 'execute', slug }
    }
    const meta = (await readMeta(slug, exec)) || { phase: 'compile', slug }
    const deviations = Array.isArray(meta.deviations) ? [...meta.deviations, clean] : [clean]
    await writeMeta(slug, { ...meta, deviations }, exec)
    return { text: `已记录偏差：${clean}（累计 ${deviations.length} 条）。`, nextAction: 'continue', phase: meta.phase || 'compile', slug }
  }

  async function actionReport(slug: string, exec?: ExecCtx): Promise<StepResult> {
    const meta = await readMeta(slug, exec)
    const phase: Phase = meta?.phase && VALID_PHASES.includes(meta.phase) ? meta.phase : 'compile'
    const text = phase === 'execute' || phase === 'done' ? await buildReport(slug, exec) : `当前阶段: ${phase} | slug: ${slug}（先 action=start 新建，再写 md 任务列表）`
    return { text, nextAction: 'continue', phase, slug }
  }

  async function actionStop(slug: string, exec?: ExecCtx): Promise<StepResult> {
    const meta = await readMeta(slug, exec)
    if (!meta || meta.phase !== 'execute') {
      return { text: `当前阶段 ${meta?.phase ?? '（无计划）'}，stop 只用于执行阶段收尾。`, nextAction: 'continue', phase: meta?.phase || 'compile', slug }
    }
    const md = (await readFile(mdPath(slug), exec)) || ''
    const tasks = parseTasks(md)
    const todoTasks = tasks.filter((t) => !t.done)
    if (todoTasks.length > 0) {
      // 收尾闸门：未完成任务列出来，不置 done（绝不静默缺失）
      return {
        text: `【收尾闸门】还有 ${todoTasks.length} 个任务未标记完成：${todoTasks.map((t) => `${t.id}（${t.title}）`).join('、')}。若确实完成了，请把 md 里对应行改成 [x] 再 stop；若放弃了，先记 deviation 再 stop。`,
        nextAction: 'continue',
        phase: 'execute',
        slug,
      }
    }
    await writeMeta(slug, { ...meta, phase: 'done' }, exec)
    return { text: `【执行完成】全部 ${tasks.length} 个任务已完成，阶段标记为 done。` + (await buildReport(slug, exec)).split('\n').slice(1).join('\n'), nextAction: 'continue', phase: 'done', slug }
  }

  async function actionContinue(slug: string, exec?: ExecCtx, phaseArg?: Phase): Promise<StepResult> {
    const meta = await readMeta(slug, exec)
    if (!meta) {
      return { text: `没有计划「${slug}」，请先 action=start 新建。`, nextAction: 'start', phase: 'compile', slug }
    }
    // 支持 phase 参数回退（如 continue&phase=compile 重新编译）
    const phase: Phase = phaseArg && VALID_PHASES.includes(phaseArg) ? phaseArg : meta.phase || 'compile'
    if (phase === 'compile') {
      return { text: `【编译计划】续跑「${slug}」。可继续编辑 ${mdPath(slug)} 的任务列表，写好后 action=confirm。`, nextAction: 'confirm', phase: 'compile', slug }
    }
    if (phase === 'execute') {
      const md = (await readFile(mdPath(slug), exec)) || ''
      const tasks = parseTasks(md)
      return { text: `【执行验收】续跑「${slug}」：已完成 ${tasks.filter((t) => t.done).length}/${tasks.length}。继续执行，或 report 看进度 / stop 收尾。`, nextAction: 'continue', phase: 'execute', slug }
    }
    return { text: `计划「${slug}」已完成。要重跑请换 slug 或删文件后 start。`, nextAction: 'start', phase: 'done', slug }
  }

  async function runCore(args: Record<string, unknown>, exec: ExecCtx): Promise<StepResult> {
    const action = typeof args.action === 'string' ? args.action : 'start'
    const slug = pickSlug(typeof args.slug === 'string' ? args.slug : undefined)
    const deviation = typeof args.deviation === 'string' ? args.deviation : undefined
    const phaseArg = typeof args.phase === 'string' ? (args.phase as Phase) : undefined

    if (action === 'start') return await actionStart(slug, exec)
    if (action === 'confirm') return await actionConfirm(slug, exec)
    if (action === 'deviation') return await actionDeviation(slug, deviation || '', exec)
    if (action === 'report') return await actionReport(slug, exec)
    if (action === 'stop') return await actionStop(slug, exec)
    if (action === 'continue') return await actionContinue(slug, exec, phaseArg)
    return { text: `未知动作「${action}」，可用：start / confirm / deviation / report / stop / continue。`, nextAction: 'continue', phase: 'compile', slug }
  }

  async function run(args: Record<string, unknown>, exec: ExecCtx): Promise<StepResult> {
    try {
      return await runCore(args, exec)
    } catch (err) {
      const slug = pickSlug(typeof args.slug === 'string' ? args.slug : undefined)
      const msg = err instanceof Error ? err.message : String(err)
      // FS_STALE_VERSION → 提醒重读；FS_NOT_OBSERVED → 提醒已有文件；其余 → 一般写失败
      const hint = msg.includes('FS_STALE_VERSION')
        ? '文件已被其他会话/工具修改，请重新读取后再试。'
        : msg.includes('FS_NOT_OBSERVED')
          ? '文件已存在（未先读取），不会覆盖。'
          : '状态未落盘，请检查工作目录与沙箱权限后重试。'
      return { text: `【失败】${msg}。${hint}`, nextAction: 'continue', phase: 'compile', slug }
    }
  }

  const disposeTool = tools.register({
    name: 'plan_execute',
    description: (config.autoTrigger
      ? '「计划实施」编排引擎的闸门与统计：任务状态以 md 勾选行为准（- [x] T1: 标题），引擎只读 md、绝不覆盖已有计划。触发：用户提出需求模糊/多步骤/项目级的新任务时，默认先 action=start 进入流程确认需求；用户说「计划实施」「编译计划」「执行计划」时同样调用；简单明确的任务不必调用；用户明确说「直接做/不用确认/跳过流程」时跳过。动作：start 新建（防覆盖）→ skill 写 md 任务列表 → confirm 开始执行 → 干完改 [x]、卡住/失败用 deviation 记 → report 看进度 → stop 收尾（未完成任务会拦住）。每次调用务必显式带 slug。 引擎 v' + VERSION + '。'
      : '「计划实施」编排引擎的闸门与统计：任务状态以 md 勾选行为准（- [x] T1: 标题），引擎只读 md、绝不覆盖已有计划。触发：仅当用户说「计划实施」「编译计划」「执行计划」时调用；用户明确说「直接做/不用确认/跳过流程」时跳过。动作：start 新建 → skill 写 md → confirm → 干完改 [x]、卡住/失败用 deviation → report → stop 收尾。每次调用务必显式带 slug。 引擎 v' + VERSION + '。'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'confirm', 'deviation', 'report', 'stop', 'continue'], description: '要执行的动作。' },
        phase: { type: 'string', enum: ['compile', 'execute', 'done'], description: '可选，限定目标阶段（continue 回退用）。' },
        deviation: { type: 'string', description: '记录一条偏差/异常，格式「failed: T1 原因」或「blocked: T2 原因」或自由文本。' },
        slug: { type: 'string', description: `项目/计划标识（必带；缺省为 ${config.defaultSlug}）。` },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          nextAction: { type: 'string' },
          phase: { type: 'string' },
          slug: { type: 'string' },
        },
        required: ['text', 'nextAction', 'phase', 'slug'],
      },
      render: (_args: unknown, value: StepResult) => [{ type: 'text', text: value.text }],
    },
    async execute(args: Record<string, unknown>, exec: ExecCtx): Promise<StepResult> {
      return await run(args, exec)
    },
  })
  ctx.effect(() => disposeTool)

  const skills = ctx.get('skills') as SkillsService | undefined
  if (skills !== undefined) {
    const disposeSkill = skills.register({
      name: 'plan-workflow',
      description: '「计划实施」编排流程的大脑：先问清楚 → 写计划 → 干完验收，配合 plan_execute 工具驱动。',
      whenToUse: config.autoTrigger
        ? '用户提出需求模糊、多步骤或项目级的新任务时（除非用户明确说「直接做/不用确认/跳过流程」），或说出「计划实施」「编译计划」「执行计划」时，加载本 skill 并驱动 plan_execute 工具。'
        : '当用户说「计划实施」「编译计划」「执行计划」时加载本 skill 并驱动 plan_execute 工具。',
      source: 'bundled',
      content: buildSkillContent('light', config.autoTrigger),
    })
    ctx.effect(() => disposeSkill)
  }
}
