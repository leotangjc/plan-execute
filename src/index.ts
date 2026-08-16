/**
 * dsh-plan-execute — 「计划实施」三合一编排引擎的「记账本」
 *
 * 一个包两个实体：
 * - 工具 `plan_execute`：状态机 + 文件落盘 + 里程碑报告（本文件）
 * - skill `plan-workflow`：编排大脑（apply 内注册，正文见 src/skill-content.ts）
 *
 * 状态落在调用会话工作目录的 `.grill/` 与 `.plan/` 文件里，可断点续跑。
 * 只通过文档化扩展接缝注册：`ctx.tools`（工具）+ `ctx.get('fs')`（落盘）+
 * `ctx.get('skills')`（skill）。文件读写遵循 DSH 的 fs 观察策略（会话 cwd +
 * `fs/write-intent` + `fs/observed`）。
 *
 * @module dsh-plan-execute
 */

import type { Context } from '@deepseek-ai/cordis'
import { buildSkillContent } from './skill-content.js'

export const name = 'dsh-plan-execute'

/** Services required before this plugin can register. */
export const inject = ['tools']

/** 插件配置；全部可选，缺省值在 apply 内合并。 */
export interface PlanExecuteConfig {
  /** 项目/计划标识缺省值（缺省 'plan'） */
  defaultSlug?: string
  /** 拷问决策记录目录（缺省 '.grill'） */
  grillDir?: string
  /** 执行计划与阶段指针目录（缺省 '.plan'） */
  planDir?: string
  /** 默认触发模式：需求模糊/多步骤/项目级新任务默认进入流程（true），否则仅触发词触发（false）。缺省 true。 */
  autoTrigger?: boolean
}

/** 结构性镜像：DSH tools 注册表。 */
export interface ToolsService {
  register(definition: PlanToolDefinition): () => void
}

/** 结构性镜像：DSH skills 注册表（只取 register 契约）。 */
export interface SkillsService {
  register(skill: {
    name: string
    description: string
    whenToUse?: string
    source: string
    content: string
  }): () => void
}

/** 结构性镜像：DSH fs 服务。 */
export interface FsInfo {
  version?: unknown
}
export interface FsTarget {
  targetKey: string
  displayPath: string
}
export interface FsService {
  resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget | undefined>
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  writeText(
    target: FsTarget,
    content: string,
    intent?: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<{ version?: unknown }>
}

/** 结构性镜像：沙箱策略服务（per-session policy，含 workspaceRoot）。 */
export interface SandboxPolicyService {
  resolve(opts?: { session?: unknown }): { mode?: string; workspaceRoot?: string } | undefined
}

/** 工具执行上下文的精简镜像。 */
export interface ExecCtx {
  signal?: AbortSignal
  agent?: { session?: { header?: { cwd?: string } } }
}

export type Phase = 'grill' | 'compile' | 'execute' | 'done'
export type NextAction = 'start' | 'answer' | 'continue' | 'report' | 'stop'

export interface StepResult {
  text: string
  nextAction: NextAction
  phase: Phase
  slug: string
}

interface Meta {
  phase?: Phase
  slug?: string
  updatedAt?: string
  compileLayer?: 'structure' | 'detail'
  /** 任务状态结构化快照（record 写入；report 优先读它，免疫 md 执行状态手改）。 */
  tasks?: Record<string, { status: string; reason?: string }>
}

export interface PlanToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    additionalProperties: boolean
    properties: Record<string, Record<string, unknown>>
    required: string[]
  }
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: StepResult): Array<{ type: string; text: string }>
  }
  execute(args: Record<string, unknown>, exec: ExecCtx): Promise<StepResult>
}

const PHASES: readonly Phase[] = ['grill', 'compile', 'execute', 'done']
const ADVANCE_WORDS = ['结束', '够了', '结束拷问', 'stop', 'done']
const PAUSE_WORDS = ['暂停', '停', '先暂停', '先停']
const TRAILING_PARTICLES = /[了吧啊呀哈呢哦嘛啦咯喽呗哟哇]+$/
const GRILL_SKELETON =
  '# 拷问决策记录\n\n## Confirmed Decisions\n\n## Constraints & Risks\n\n## Unresolved Backlog\n'
const VALID_SECTIONS = ['任务列表', '依赖图', '验收标准', '风险与假设', '未决项映射', '里程碑'] as const

function planHead(slug: string, grillDir: string): string {
  return `# 执行计划: ${slug}\n\n> 输入来源: ${grillDir}/${slug}.md\n\n## 任务列表\n\n## 依赖图\n\n## 验收标准\n\n## 风险与假设\n\n## 未决项映射\n\n## 里程碑\n\n## 确认记录\n\n## 执行状态\n\n## 偏差记录\n`
}

export function apply(ctx: Context, _config: PlanExecuteConfig = {}) {
  const config = {
    defaultSlug: 'plan',
    grillDir: '.grill',
    planDir: '.plan',
    autoTrigger: true,
    ..._config,
  }
  const fs = ctx.get('fs') as FsService | undefined
  if (fs === undefined) return
  const tools = ctx.get('tools') as ToolsService | undefined
  if (tools === undefined) return
  // 沙箱策略服务（存在时）：写文件必须带 per-session 策略（workspaceRoot=会话 cwd），
  // 否则沙箱回退部署默认策略、不含会话工作区 → workspace-write 下写被拒。
  const policySvc = ctx.get('sandboxPolicy') as SandboxPolicyService | undefined

  const looseCtx = ctx as unknown as {
    emit: (name: string, ...args: unknown[]) => void
    waterfall: (name: string, ...args: unknown[]) => Promise<unknown>
  }
  const emit = (name: string, ...args: unknown[]) => looseCtx.emit(name, ...args)
  const waterfall = (name: string, ...args: unknown[]) => looseCtx.waterfall(name, ...args)

  const metaPath = (slug: string) => `${config.planDir}/${slug}.meta.json`
  const grillPath = (slug: string) => `${config.grillDir}/${slug}.md`
  const planPath = (slug: string) => `${config.planDir}/${slug}.md`

  const sessionCwd = (exec?: ExecCtx) => exec?.agent?.session?.header?.cwd

  function resolvePath(rel: string, exec?: ExecCtx): Promise<FsTarget | undefined> {
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

  async function writeFile(rel: string, content: string, exec?: ExecCtx): Promise<void> {
    const policy = policySvc?.resolve({ session: exec?.agent?.session })
    const cwd = policy?.workspaceRoot ?? sessionCwd(exec)
    const target = await fs!.resolve(rel, cwd !== undefined ? { cwd } : undefined)
    if (target === undefined) return
    const info = await fs!.stat(target, exec?.signal)
    emit(
      'fs/observed',
      target,
      info ? { kind: 'present', version: info.version } : { kind: 'absent' },
      exec,
    )
    const intent = await waterfall('fs/write-intent', target, exec, () => undefined)
    const outcome = await fs!.writeText(target, content, intent, exec?.signal, policy)
    emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  }

  // —— 活动 slug 指针：非 start 调用漏传 slug 时兜底用「最近一次的计划」，避免落默认 plan / 阶段错乱 ——
  const currentSlugPath = () => `${config.planDir}/.current`
  async function writeCurrentSlug(value: string, exec?: ExecCtx): Promise<void> {
    await writeFile(currentSlugPath(), value, exec)
  }
  async function readCurrentSlug(exec?: ExecCtx): Promise<string | undefined> {
    return (await readFile(currentSlugPath(), exec))?.trim()
  }
  /** 指针兜底：仅当指针所指计划确实存在状态文件时才用，否则回默认（防过期/静默错计划）。 */
  async function pointerFallback(exec?: ExecCtx): Promise<string> {
    const current = await readCurrentSlug(exec)
    if (current && current !== pickSlug(undefined)) {
      const hasGrill = (await readFile(grillPath(current), exec)) !== undefined
      const hasPlan = (await readFile(planPath(current), exec)) !== undefined
      if (hasGrill || hasPlan) return current
    }
    return pickSlug(undefined)
  }

  async function readMeta(slug: string, exec?: ExecCtx): Promise<Meta | undefined> {
    try {
      const c = await readFile(metaPath(slug), exec)
      if (!c) return undefined
      return JSON.parse(c) as Meta
    } catch {
      return undefined
    }
  }
  async function writeMeta(slug: string, meta: Meta, exec?: ExecCtx): Promise<void> {
    meta.updatedAt = new Date().toISOString()
    await writeFile(metaPath(slug), JSON.stringify(meta, null, 2), exec)
  }

  /** 短哈希（djb2，8 位 hex）：纯非 ASCII 名（如中文）兜底为可读唯一 slug。8 位在 5000 个项目下碰撞 ≈0.3%。 */
  function hash8(text: string): string {
    let h = 5381
    for (const ch of text) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0
    return h.toString(16).padStart(8, '0').slice(0, 8)
  }

  function pickSlug(slug?: string): string {
    const raw = (slug ?? '').trim()
    const s = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    if (s) return s.slice(0, 64)
    // 空/缺省 → 默认 plan；纯非 ASCII（如中文项目名）→ plan-短哈希，避免全部坍缩成 plan 互相覆盖
    return raw ? `plan-${hash8(raw)}` : config.defaultSlug
  }

  function escapeReg(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /** 归一化：去尾部标点，循环剥语气词/「一下」（最多 5 轮），返回可比较文本。 */
  function normalizeStop(text: string): string {
    let n = text.trim().replace(/[。．.！？!?，,、；;~～]+$/g, '').toLowerCase()
    for (let i = 0; i < 5; i++) {
      if (TRAILING_PARTICLES.test(n)) n = n.slice(0, -1)
      else if (n.endsWith('一下')) n = n.slice(0, -2)
      else break
    }
    return n
  }
  function hitWord(text: string, words: readonly string[]): boolean {
    const lower = words.map((w) => w.toLowerCase())
    let n = text.trim().replace(/[。．.！？!?，,、；;~～]+$/g, '').toLowerCase()
    // 每剥一步都查一次词表（含重复词），防止「够了呀」剥掉词尾“了”后失配
    for (let i = 0; i < 5; i++) {
      if (lower.includes(n)) return true
      if (lower.some((w) => n === w.repeat(2) || n === w.repeat(3))) return true
      // 口语省略词尾「了」：够啦 → 够 ≈ 够了
      if (lower.some((w) => w.endsWith('了') && n === w.slice(0, -1))) return true
      if (TRAILING_PARTICLES.test(n)) n = n.slice(0, -1)
      else if (n.endsWith('一下')) n = n.slice(0, -2)
      else break
    }
    return (
      lower.includes(n) ||
      lower.some((w) => n === w.repeat(2) || n === w.repeat(3)) ||
      lower.some((w) => w.endsWith('了') && n === w.slice(0, -1))
    )
  }
  function hitAdvance(text: string): boolean {
    return hitWord(text, ADVANCE_WORDS)
  }
  function hitPause(text: string): boolean {
    return hitWord(text, PAUSE_WORDS)
  }

  async function currentPhase(slug: string, exec?: ExecCtx): Promise<Phase> {
    const meta = await readMeta(slug, exec)
    if (meta && meta.phase && PHASES.includes(meta.phase)) return meta.phase
    const hasPlan = (await readFile(planPath(slug), exec)) !== undefined
    const hasGrill = (await readFile(grillPath(slug), exec)) !== undefined
    if (hasPlan) return 'execute'
    if (hasGrill) return 'compile'
    return 'grill'
  }

  async function appendGrillRecord(slug: string, qLabel: string, answer: string, exec?: ExecCtx) {
    const cur = (await readFile(grillPath(slug), exec)) || GRILL_SKELETON
    const marker = '## Constraints & Risks'
    const confirmed = cur.split('## Confirmed Decisions')[1]?.split('## Constraints & Risks')[0] ?? ''
    const index = confirmed.split('\n').filter((l) => /^- Q\d+[：:]/.test(l.trim())).length
    const n = index + 1
    const block = `- Q${n}：${qLabel}\n- A${n}：${answer.trim()}\n\n`
    const next = cur.includes(marker) ? cur.replace(marker, block + marker) : cur + '\n' + block
    await writeFile(grillPath(slug), next, exec)
  }

  /** 统计 .grill 的 Unresolved Backlog 未决项数（节内非空 - 行）。 */
  function countBacklog(grill: string): number {
    const rest = grill.split('## Unresolved Backlog')[1] ?? ''
    const section = rest.split(/^##\s/m)[0] ?? ''
    return section.split('\n').map((l) => l.trim()).filter((l) => l.length > 1 && l.startsWith('-') && !/^- ?(\[[xX✓]\]|[✓✔])/.test(l)).length
  }

  async function openCompile(slug: string, exec?: ExecCtx): Promise<StepResult> {
    const g = await readFile(grillPath(slug), exec)
    if (!g) {
      return { text: `未找到 ${config.grillDir}/${slug}.md，请先完成「拷问决策」。`, nextAction: 'answer', phase: 'compile', slug }
    }
    const open = countBacklog(g)
    if (open > 0) {
      return {
        text: `【编译计划】暂缓：Unresolved Backlog 尚有 ${open} 项未决。先与用户确认这些项：已处理/忽略的可把行删掉或标成「- [x] …」，需带进计划的写进「未决项映射」；处理完（backlog 无未标 [x] 的项）后再说「结束」进入编译。`,
        nextAction: 'answer', phase: 'compile', slug,
      }
    }
    const p = await readFile(planPath(slug), exec)
    if (!p) await writeFile(planPath(slug), planHead(slug, config.grillDir), exec)
    await writeMeta(slug, { phase: 'compile', slug, compileLayer: 'structure' }, exec)
    return {
      text: '【编译计划】第一层确认（结构）：里程碑分组 + 每里程碑 ≤3 个关键拆解假设 + 依赖骨架。请确认或修改。',
      nextAction: 'answer', phase: 'compile', slug,
    }
  }

  async function resumeCompile(slug: string, exec?: ExecCtx): Promise<StepResult> {
    const g = await readFile(grillPath(slug), exec)
    if (!g) {
      return { text: `未找到 ${config.grillDir}/${slug}.md，请先完成「拷问决策」。`, nextAction: 'answer', phase: 'compile', slug }
    }
    const prev = (await readMeta(slug, exec)) || {}
    const layer = prev.compileLayer === 'detail' ? 'detail' : 'structure'
    await writeMeta(slug, { phase: 'compile', slug, compileLayer: layer }, exec)
    return layer === 'structure'
      ? { text: '【编译计划】第一层确认（结构）：里程碑分组 + 每里程碑 ≤3 个关键拆解假设 + 依赖骨架。请确认或修改。', nextAction: 'answer', phase: 'compile', slug }
      : { text: '【编译计划】继续第二层确认（细节）：完整任务列表 + 每任务验收标准，默认通过，仅需回改反对项。请确认或列明反对项。', nextAction: 'answer', phase: 'compile', slug }
  }

  async function openExecute(slug: string, exec?: ExecCtx): Promise<StepResult> {
    const p = await readFile(planPath(slug), exec)
    if (!p) {
      return { text: `未找到 ${config.planDir}/${slug}.md，请先完成「编译计划」。`, nextAction: 'answer', phase: 'execute', slug }
    }
    await writeMeta(slug, { phase: 'execute', slug }, exec)
    return {
      text: '【执行验收】开始。逐任务执行、跑可观察验收；用 record 回写状态、deviation 记偏差、action=report 看里程碑；结束说「结束」。',
      nextAction: 'answer', phase: 'execute', slug,
    }
  }

  // ============ grill ============
  async function grillAction(
    action: string,
    slug: string,
    answer: string | undefined,
    question: string | undefined,
    exec?: ExecCtx,
  ): Promise<StepResult> {
    if (action === 'start') {
      const g = await readFile(grillPath(slug), exec)
      if (!g) await writeFile(grillPath(slug), GRILL_SKELETON, exec)
      await writeMeta(slug, { phase: 'grill', slug }, exec)
      const cwd = sessionCwd(exec) ?? '(未知)'
      return {
        text: `【拷问决策】开始（工作目录 ${cwd}，项目 ${slug}）。请主 agent 读取代码库、按依赖序逐题拷问；用 question 参数喂题、answer 参数带回答复；用户说「结束」进入编译阶段。`,
        nextAction: 'answer', phase: 'grill', slug,
      }
    }
    if (action === 'answer') {
      if (!answer || !answer.trim()) {
        return { text: '请提供对上一题的回答。', nextAction: 'answer', phase: 'grill', slug }
      }
      if (hitAdvance(answer)) {
        return await openCompile(slug, exec)
      }
      if (hitPause(answer)) {
        return {
          text: '已暂停（停留在拷问阶段）。若有未决问题，先与用户确认并把未决项写入 .grill 的 Unresolved Backlog；想继续拷问就继续提问，想结束本阶段说「结束」。',
          nextAction: 'answer', phase: 'grill', slug,
        }
      }
      if (!question || !question.trim()) {
        return { text: '请用 question 参数指定本次回答对应的问题。', nextAction: 'answer', phase: 'grill', slug }
      }
      await appendGrillRecord(slug, question.trim(), answer, exec)
      return { text: '已记录。请继续提问，或说「结束」收尾。', nextAction: 'answer', phase: 'grill', slug }
    }
    return { text: '未知动作。', nextAction: 'answer', phase: 'grill', slug }
  }

  // ============ compile ============
  async function appendPlanSection(slug: string, section: string, body: string, exec?: ExecCtx) {
    const cur = (await readFile(planPath(slug), exec)) || planHead(slug, config.grillDir)
    const anchor = '## 执行状态'
    const block = `### ${section}\n${body.trim()}\n\n`
    const next = cur.includes(anchor) ? cur.replace(anchor, block + anchor) : cur + '\n' + block
    await writeFile(planPath(slug), next, exec)
  }

  async function writePlanSection(slug: string, section: string, content: string, exec?: ExecCtx): Promise<void> {
    const cur = (await readFile(planPath(slug), exec)) || planHead(slug, config.grillDir)
    const lines = cur.split('\n')
    const hdr = lines.findIndex((l) => l.trim() === `## ${section}`)
    if (hdr < 0) {
      await writeFile(planPath(slug), cur + `\n## ${section}\n\n${content.trim()}\n`, exec)
      return
    }
    let end = lines.length
    for (let i = hdr + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break }
    }
    const next = [...lines.slice(0, hdr + 1), '', content.trim(), '', ...lines.slice(end)].join('\n')
    await writeFile(planPath(slug), next, exec)
  }

  async function compileAction(action: string, slug: string, answer: string | undefined, exec?: ExecCtx): Promise<StepResult> {
    if (action === 'start') return await openCompile(slug, exec)
    if (action === 'continue') return await resumeCompile(slug, exec)
    if (action === 'answer') {
      if (!answer || !answer.trim()) {
        return { text: '请提供确认/修改意见。', nextAction: 'answer', phase: 'compile', slug }
      }
      if (hitAdvance(answer)) {
        return await openExecute(slug, exec)
      }
      if (hitPause(answer)) {
        return { text: '已暂停（停留在编译阶段）。先与用户确认未决项，确认后说「结束」进入执行。', nextAction: 'answer', phase: 'compile', slug }
      }
      const meta = (await readMeta(slug, exec)) || { phase: 'compile', slug, compileLayer: 'structure' as const }
      if (meta.compileLayer === 'structure') {
        await appendPlanSection(slug, '结构确认', answer, exec)
        await writeMeta(slug, { phase: 'compile', slug, compileLayer: 'detail' }, exec)
        return {
          text: '结构已记录。第二层确认（细节）：完整任务列表 + 每任务验收标准，默认通过，仅需回改反对项。请确认或列明反对项。',
          nextAction: 'answer', phase: 'compile', slug,
        }
      }
      await appendPlanSection(slug, '细节确认', answer, exec)
      return await openExecute(slug, exec)
    }
    return { text: '未知动作。', nextAction: 'answer', phase: 'compile', slug }
  }

  // ============ execute ============
  async function buildReport(slug: string, exec?: ExecCtx): Promise<string> {
    const meta = await readMeta(slug, exec)
    const plan = (await readFile(planPath(slug), exec)) || ''
    const devSection = plan.split('## 偏差记录')[1] ?? ''
    const deviations = devSection
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-'))
      .map((l) => l.replace(/^-\s*/, ''))
      .filter(Boolean)
    const render = (counts: Record<string, number>, failed: string[], blocked: string[], hasTasks: boolean) => {
      if (!hasTasks && deviations.length === 0) {
        return '【里程碑报告】\n- 尚无执行状态记录。请用 record 参数写入任务状态（如 record="T1 done"）；「执行状态」节由工具写，勿手改。'
      }
      return [
        '【里程碑报告】',
        `- done: ${counts.done}`,
        `- doing: ${counts.doing}`,
        `- todo: ${counts.todo}`,
        `- failed: ${counts.failed}${failed.length ? '（' + failed.join('；') + '）' : ''}`,
        `- blocked: ${counts.blocked}${blocked.length ? '（' + blocked.join('；') + '）' : ''}`,
        `- deviations: ${deviations.length}${deviations.length ? '（' + deviations.join('；') + '）' : ''}`,
      ].join('\n')
    }
    // 结构化优先：record 写入的 meta.tasks 为事实源（对 md 执行状态手改免疫）；缺失时回退解析 md
    if (meta && meta.tasks !== undefined) {
      const counts: Record<string, number> = { done: 0, doing: 0, todo: 0, failed: 0, blocked: 0 }
      const failed: string[] = []
      const blocked: string[] = []
      for (const [id, rec] of Object.entries(meta.tasks)) {
        counts[rec.status] = (counts[rec.status] ?? 0) + 1
        if (rec.status === 'failed') failed.push(`${id}: ${rec.reason || '(无描述)'}`)
        if (rec.status === 'blocked') blocked.push(`${id}: ${rec.reason || '(无描述)'}`)
      }
      return render(counts, failed, blocked, Object.keys(meta.tasks).length > 0)
    }
    // —— 回退：解析 md 执行状态节（老数据 / 无 tasks 快照）——
    const section = (plan.split('## 执行状态')[1] ?? '').split(/^##\s/m)[0] ?? ''
    const lines = section.split('\n')
    const latest: Record<string, { status: string; reason: string }> = {}
    let checkDone = 0
    let checkTodo = 0
    for (const line of lines) {
      const m = line.match(/^\s*[-*]\s+([^\s:：]+)\s*[:：]?\s*(doing|done|failed|blocked|todo)(?=[\s，,、；;。．.!？?：:～~]|$)\s*(.*)$/)
      if (m) {
        latest[m[1]] = { status: m[2], reason: m[3].trim().replace(/^[\s，,、；;:：]+/, '') }
        continue
      }
      if (/^\s*[-*]\s*\[x\]/i.test(line)) checkDone += 1
      else if (/^\s*[-*]\s*\[ \]/.test(line)) checkTodo += 1
    }
    const counts: Record<string, number> = { done: 0, doing: 0, todo: 0, failed: 0, blocked: 0 }
    const failed: string[] = []
    const blocked: string[] = []
    for (const [id, rec] of Object.entries(latest)) {
      counts[rec.status] = (counts[rec.status] ?? 0) + 1
      if (rec.status === 'failed') failed.push(`${id}: ${rec.reason || '(无描述)'}`)
      if (rec.status === 'blocked') blocked.push(`${id}: ${rec.reason || '(无描述)'}`)
    }
    counts.done += checkDone
    counts.todo += checkTodo
    return render(counts, failed, blocked, Object.keys(latest).length + checkDone + checkTodo > 0)
  }

  async function recordStatus(slug: string, record: string, exec?: ExecCtx): Promise<string> {
    const m = record.trim().match(/^([^\s:：]+)\s*[:：]?\s*(doing|done|failed|blocked|todo)\b\s*(.*)$/)
    if (!m) return `无法解析记录「${record}」，格式应为「任务ID 状态 [原因]」，状态 ∈ doing/done/failed/blocked/todo。`
    const [, id, status] = m
    const reason = m[3].trim().replace(/^[\s，,、；;:：]+/, '')
    const cur = (await readFile(planPath(slug), exec)) || planHead(slug, config.grillDir)
    const anchor = '## 执行状态'
    const line = `- ${id}: ${status}${reason.trim() ? ' ' + reason.trim() : ''}`
    const lines = cur.split('\n')
    const idx = lines.findIndex((l) => new RegExp(`^\\s*[-*]\\s+${escapeReg(id)}\\s*[:：]`).test(l))
    let next: string
    if (idx >= 0) {
      lines[idx] = line
      next = lines.join('\n')
    } else if (cur.includes(anchor)) {
      next = cur.replace(anchor, anchor + '\n' + line)
    } else {
      next = cur + '\n' + anchor + '\n' + line
    }
    await writeFile(planPath(slug), next, exec)
    // 结构化快照：同步写进 meta.json（report 优先读它，免疫 md 执行状态手改）
    const prev = (await readMeta(slug, exec)) || {}
    const tasks = { ...(prev.tasks || {}) }
    tasks[id] = { status, reason }
    await writeMeta(slug, { ...prev, phase: prev.phase || 'execute', tasks }, exec)
    return `已记录：${id} → ${status}`
  }

  async function recordDeviation(slug: string, text: string, exec?: ExecCtx): Promise<string> {
    const cur = (await readFile(planPath(slug), exec)) || planHead(slug, config.grillDir)
    const anchor = '## 偏差记录'
    const line = `- ${text.trim()}\n`
    const next = cur.includes(anchor) ? cur.replace(anchor, anchor + '\n' + line) : cur + '\n' + anchor + '\n' + line
    await writeFile(planPath(slug), next, exec)
    return `已记录偏差：${text.trim()}`
  }

  async function executeAction(
    action: string,
    slug: string,
    answer: string | undefined,
    record: string | undefined,
    deviation: string | undefined,
    exec?: ExecCtx,
  ): Promise<StepResult> {
    if (action === 'start' || action === 'continue') return await openExecute(slug, exec)
    if (record && record.trim()) {
      const msg = await recordStatus(slug, record, exec)
      return { text: msg, nextAction: 'answer', phase: 'execute', slug }
    }
    if (deviation && deviation.trim()) {
      const msg = await recordDeviation(slug, deviation, exec)
      return { text: msg, nextAction: 'answer', phase: 'execute', slug }
    }
    if (action === 'answer') {
      if (!answer) {
        return { text: '请回复「结束」收尾，或用 record 回写状态、deviation 记偏差、action=report 看里程碑。', nextAction: 'answer', phase: 'execute', slug }
      }
      if (hitAdvance(answer)) {
        await writeMeta(slug, { phase: 'done', slug }, exec)
        return { text: '【执行验收】已结束，阶段标记为 done。', nextAction: 'stop', phase: 'done', slug }
      }
      if (hitPause(answer)) {
        return { text: '已暂停（停留在执行阶段）。进度已落盘；想继续执行就继续，想收尾说「结束」。', nextAction: 'answer', phase: 'execute', slug }
      }
      return { text: '请继续执行下一个任务，或用 record 回写状态、deviation 记偏差、action=report 查看里程碑。', nextAction: 'answer', phase: 'execute', slug }
    }
    return { text: '未知动作。', nextAction: 'answer', phase: 'execute', slug }
  }

  // ============ 总入口 ============
  async function run(args: Record<string, unknown>, exec: ExecCtx): Promise<StepResult> {
    const action = typeof args.action === 'string' ? args.action : 'start'
    const explicitSlug = typeof args.slug === 'string' && args.slug.trim() !== '' ? args.slug : undefined
    // slug 解析：start 无 slug → 默认；显式 → 用之并刷新指针；非 start 无 slug → 指针兜底（校验状态存在），否则默认。
    const slug =
      action === 'start' && explicitSlug === undefined
        ? pickSlug(undefined)
        : explicitSlug !== undefined
          ? pickSlug(explicitSlug)
          : await pointerFallback(exec)
    // 记录最近一次活动的计划（start 或显式给 slug 时写；指针是兜底，写失败不影响主流程）
    if (explicitSlug !== undefined || action === 'start') {
      await writeCurrentSlug(slug, exec).catch(() => {})
    }
    const answer = typeof args.answer === 'string' ? args.answer : undefined
    const record = typeof args.record === 'string' ? args.record : undefined
    const question = typeof args.question === 'string' ? args.question : undefined
    const section = typeof args.section === 'string' ? args.section.trim() : undefined
    const content = typeof args.content === 'string' ? args.content : undefined
    const deviation = typeof args.deviation === 'string' ? args.deviation : undefined
    const phase = typeof args.phase === 'string' ? (args.phase as Phase) : undefined

    if (action === 'report') {
      const meta = await readMeta(slug, exec)
      const ph = phase && PHASES.includes(phase) ? phase : meta && meta.phase ? meta.phase : await currentPhase(slug, exec)
      if (ph === 'execute') {
        return { text: await buildReport(slug, exec), nextAction: 'answer', phase: 'execute', slug }
      }
      return { text: `当前阶段: ${ph} | slug: ${slug}`, nextAction: 'continue', phase: ph, slug }
    }
    if (action === 'stop') {
      await writeMeta(slug, { phase: 'done', slug }, exec)
      return { text: '已安全停止，状态写回。', nextAction: 'stop', phase: 'done', slug }
    }

    if (section && content !== undefined) {
      if (!(VALID_SECTIONS as readonly string[]).includes(section)) {
        return { text: `未知计划字段「${section}」，可用：${VALID_SECTIONS.join(' / ')}。`, nextAction: 'continue', phase: phase ?? 'compile', slug }
      }
      await writePlanSection(slug, section, content, exec)
      return { text: `已写入计划字段「${section}」。`, nextAction: 'continue', phase: phase ?? 'compile', slug }
    }

    let phaseNow: Phase
    if (phase && PHASES.includes(phase)) {
      phaseNow = phase
    } else if (action === 'start') {
      // 无显式 phase 的 start = 新建：绝不静默覆盖/接管已有计划
      const meta = await readMeta(slug, exec)
      const hasGrill = (await readFile(grillPath(slug), exec)) !== undefined
      const hasPlan = (await readFile(planPath(slug), exec)) !== undefined
      if (meta || hasGrill || hasPlan) {
        const ph: Phase = meta?.phase && PHASES.includes(meta.phase) ? meta.phase : hasPlan ? 'execute' : hasGrill ? 'compile' : 'grill'
        const cwd = sessionCwd(exec) ?? '(未知)'
        return {
          text: `检测到 ${cwd} 下已存在计划「${slug}」（阶段 ${ph}）。start 不会覆盖已有计划：续跑请用 action=continue；新建请换一个 slug；彻底重来请先删除 .grill/ 与 .plan/ 下该计划的文件。`,
          nextAction: 'continue', phase: ph, slug,
        }
      }
      // 兼容旧版：纯中文项目名曾坍缩为 defaultSlug（'plan'）——新哈希 slug 无自身状态但旧 plan 有状态时提示续跑入口
      if (/^plan-[0-9a-f]{6,8}$/.test(slug) && slug !== config.defaultSlug) {
        const legacyHasGrill = (await readFile(grillPath(config.defaultSlug), exec)) !== undefined
        const legacyHasPlan = (await readFile(planPath(config.defaultSlug), exec)) !== undefined
        if (legacyHasGrill || legacyHasPlan) {
          const ph: Phase = legacyHasPlan ? 'execute' : legacyHasGrill ? 'compile' : 'grill'
          return {
            text: `检测到旧版默认计划「${config.defaultSlug}」的状态文件（${config.grillDir}/${config.defaultSlug}.md 等）——可能是旧版中文项目名落盘的。想续跑旧状态请显式传 slug=${config.defaultSlug} 并用 action=continue；想新建本计划「${slug}」请用 action=start 并显式带 phase=grill（否则会重复此提示）。`,
            nextAction: 'continue', phase: ph, slug,
          }
        }
      }
      phaseNow = 'grill'
    } else {
      phaseNow = await currentPhase(slug, exec)
    }

    if (phaseNow === 'grill') return await grillAction(action, slug, answer, question, exec)
    if (phaseNow === 'compile') return await compileAction(action, slug, answer, exec)
    if (phaseNow === 'execute') return await executeAction(action, slug, answer, record, deviation, exec)
    if (phaseNow === 'done') return { text: '流程已完成。如需重跑：换一个 slug 新建，或删除 .grill/.plan 文件后 action=start。', nextAction: 'start', phase: 'done', slug }
    return { text: '无法判定阶段。', nextAction: 'start', phase: 'grill', slug }
  }

  const disposeTool = tools.register({
    name: 'plan_execute',
    description: (config.autoTrigger
      ? '「计划实施」三合一编排引擎的记账本（状态机）：拷问决策(grill)→编译计划(compile)→执行验收(execute)。先用 skill 工具加载 plan-workflow 获取完整流程与提问策略，再驱动本工具。触发：用户提出需求模糊/多步骤/项目级的新任务时，默认先调用本工具进入「拷问决策」确认需求，未经确认不得直接动手；用户说「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」时同样调用；简单明确、一步可完成的请求不必调用；用户明确说「直接做/不用确认/跳过流程」时跳过本流程。多步驱动(action=start/answer/continue/report/stop)；说「结束」结束当前阶段，说「暂停」停留在本阶段；主 agent 用 question 喂题、section+content 写计划字段、record/deviation 回写执行状态。'
      : '「计划实施」三合一编排引擎的记账本（状态机）：拷问决策(grill)→编译计划(compile)→执行验收(execute)。先用 skill 工具加载 plan-workflow 获取完整流程与提问策略，再驱动本工具。触发：仅当用户说「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」时调用本工具；用户明确说「直接做/不用确认/跳过流程」时跳过本流程。多步驱动(action=start/answer/continue/report/stop)；说「结束」结束当前阶段，说「暂停」停留在本阶段；主 agent 用 question 喂题、section+content 写计划字段、record/deviation 回写执行状态。'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'answer', 'continue', 'report', 'stop'], description: '要执行的动作。' },
        phase: { type: 'string', enum: ['grill', 'compile', 'execute'], description: '可选，限定目标阶段。' },
        answer: { type: 'string', description: '用户对上一题的最终答复（answer 动作使用）。' },
        question: { type: 'string', description: '拷问阶段：主 agent 提出的问题（本次 answer 对应的问题）。' },
        section: { type: 'string', description: '计划字段名：任务列表 / 依赖图 / 验收标准 / 风险与假设 / 未决项映射 / 里程碑。' },
        content: { type: 'string', description: '与 section 搭配：写入该计划字段的正文。' },
        record: { type: 'string', description: '执行阶段任务状态「任务ID 状态 [原因]」，状态 doing/done/failed/blocked/todo。' },
        deviation: { type: 'string', description: '执行阶段记录一条与计划的偏差。' },
        slug: { type: 'string', description: `项目/计划标识，缺省为 ${config.defaultSlug}。` },
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

  // 注册编排大脑 skill（可选：无 skills 服务时跳过，工具仍可被模型即兴驱动）。
  const skills = ctx.get('skills') as SkillsService | undefined
  if (skills !== undefined) {
    const disposeSkill = skills.register({
      name: 'plan-workflow',
      description: '「计划实施」三合一编排流程的大脑：拷问决策→编译计划→执行验收，配合 plan_execute 工具落盘。',
      whenToUse: config.autoTrigger
        ? '用户提出需求模糊、多步骤或项目级的新任务时（除非用户明确说「直接做/不用确认/跳过流程」），或说出「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」时，加载本 skill 并驱动 plan_execute 工具。'
        : '当用户说「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」时加载本 skill 并驱动 plan_execute 工具。',
      source: 'bundled',
      content: buildSkillContent(config.autoTrigger),
    })
    ctx.effect(() => disposeSkill)
  }
}
