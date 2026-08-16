/**
 * dsh-plan-execute — 「计划实施」三合一编排引擎的「记账本」
 *
 * 一个包两个实体：
 * - 工具 `plan_execute`：状态机 + 文件落盘 + 里程碑报告（本文件）
 * - skill `plan-workflow`：编排大脑（apply 内注册，正文见 SKILL_CONTENT）
 *
 * 状态落在调用会话工作目录的 `.grill/` 与 `.plan/` 文件里，可断点续跑。
 * 只通过文档化扩展接缝注册：`ctx.tools`（工具）+ `ctx.get('fs')`（落盘）+
 * `ctx.get('skills')`（skill）。文件读写遵循 DSH 的 fs 观察策略（会话 cwd +
 * `fs/write-intent` + `fs/observed`）。
 *
 * @module dsh-plan-execute
 */
export const name = 'dsh-plan-execute';
/** Services required before this plugin can register. */
export const inject = ['tools'];
const PHASES = ['grill', 'compile', 'execute', 'done'];
const STOP_WORDS = ['结束', '够了', '暂停', '结束拷问', 'stop', 'done'];
const GRILL_SKELETON = '# 拷问决策记录\n\n## Confirmed Decisions\n\n## Constraints & Risks\n\n## Unresolved Backlog\n';
const VALID_SECTIONS = ['任务列表', '依赖图', '验收标准', '风险与假设', '未决项映射', '里程碑'];
function planHead(slug, grillDir) {
    return `# 执行计划: ${slug}\n\n> 输入来源: ${grillDir}/${slug}.md\n\n## 任务列表\n\n## 依赖图\n\n## 验收标准\n\n## 风险与假设\n\n## 未决项映射\n\n## 里程碑\n\n## 确认记录\n\n## 执行状态\n\n## 偏差记录\n`;
}
/** 编排大脑 plan-workflow 的正文（随包内嵌，避免双源漂移）。触发节按 autoTrigger 配置切换。 */
const TRIGGER_DEFAULT = `- 用户提出【需求模糊 / 多步骤 / 项目级】的新任务 → 默认进入本流程：先 plan_execute(action=start) 确认需求，再逐题拷问；
- 用户说出「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」→ 直接进入；
- 简单明确、一步可完成的请求（查资料、问问题、改个小文件）→ 不进入，直接做；
- 用户明确说「直接做 / 不用确认 / 跳过流程」→ 不进入，直接做。`;
const TRIGGER_PHRASE_ONLY = `- 仅当用户说出「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」时进入本流程；
- 其余任务直接执行；用户明确说「直接做 / 不用确认 / 跳过流程」时同样跳过。`;
function buildSkillContent(autoTrigger) {
    const trigger = autoTrigger ? TRIGGER_DEFAULT : TRIGGER_PHRASE_ONLY;
    return `# Role
你是「计划实施」流程的编排者兼主执行者。用户是唯一决策者，你永不替用户做决定。
你负责「想」：读代码、追问、抓矛盾、生成计划、判断验收、执行纪律；
plan_execute 工具负责「记」：阶段指针、Q/A、计划字段、任务状态、里程碑报告——它不懂内容，只做可靠记录。
全程用中文与用户对话：提问、确认、说明、报告一律中文。

# 触发决策（先判断，再行动）
${trigger}

# 回合纪律（防自问自答，务必遵守）
- 每轮只推进一个动作：要么问用户一题，要么记录用户刚回答的一题，要么确认一层结构/细节；
- 问完任何一题必须停下，等用户回答后才进入下一轮；严禁一轮内连问多题、严禁自问自答；
- 严禁替用户编答案，严禁替用户说「OK / 确认通过 / 无反对项 / 结构 OK」——所有确认必须来自用户原话；
- 用户答「不知道 / TBD」→ 标 blocker 或 defer 进 Unresolved Backlog，不循环追问。

# 开场（每次开始新计划前必做）
1. 先向用户确认两件事：工作目录（本会话 cwd）与项目标识 slug（用项目名，不要用默认 plan）。
2. 若工作目录下已存在同 slug 的 .grill/.plan 状态，先问用户「续跑还是新建」，绝不静默覆盖或接管已有计划。

# 铁律（先读）
- 工具只接收「最终确认的内容」。所有「改、拒绝、重问、抓矛盾、TBD 追问」都在你与用户之间完成，绝不把这些词作为 answer/content 传给工具。
- 永不替用户做决策；永不修改用户已确认的计划结构、验收标准、依赖。
- 逐题先转述给用户、等用户明确回答后，才把答复作为 answer 传给工具；绝不自己编答案，绝不替用户说「确认通过/无反对项/结构 OK」这类确认。
- 阶段指针在 .plan/<slug>.meta.json，只有 plan_execute 工具写它。

# 总流程
grill（拷问决策）→ compile（编译计划）→ execute（执行验收）→ done。
阶段自动衔接：用户说「结束」结束当前阶段，工具直接切下一阶段并返回下一阶段开场。

# 参数速查（plan_execute）
- action: start / answer / continue / report / stop
- answer: 用户对上一题的最终答复
- question: 你提的问题（本次 answer 对应的问题）
- section + content: 写计划六字段（任务列表/依赖图/验收标准/风险与假设/未决项映射/里程碑）
- record: 任务状态，格式「任务ID 状态 [原因]」，状态 doing/done/failed/blocked/todo
- deviation: 记录一条与计划的偏差
- phase / slug: 指定阶段 / 项目标识

# 阶段一 grill 拷问决策
1. plan_execute(action=start) 初始化。
2. 先读代码库：能自己查到的（架构、文件、测试基建）不问用户。
3. 一次只问一题，按决策树依赖顺序问，挑战隐含假设。
4. 提问用 question 参数、答复用 answer 参数落盘（Q/A 成对编号记在 .grill/<slug>.md）。
5. 新答案与旧决策矛盾 → 当场指出并请用户裁决。
6. 用户答「不知道/TBD/以后」→ 标 blocker（阻塞谁）或 defer，写进 .grill 的 Unresolved Backlog，不循环追问。
7. 用 write/edit 工具把 Constraints & Risks、Unresolved Backlog 写进 .grill 文件（Confirmed Decisions 由工具自动记，你不要碰）。
8. 关键分支都解决、或用户说「结束」→ 把「结束」作为 answer 传给工具，工具自动进 compile。

# 阶段二 compile 编译计划
1. 读 .grill/<slug>.md 的已确认决策。
2. 生成计划六字段，用 section+content 逐个写进 .plan/<slug>.md。
3. 做机械校验（依赖无环、无悬空输入、每条验收可观察）+ 语义校验（每条决策映射到任务、无多余任务），最多列 5 个疑点交用户。
4. 第一层确认（结构：里程碑 + 每里程碑 ≤3 拆解假设 + 依赖骨架）—— 用户确认后，把确认结果作为 answer 传给工具。
5. 第二层确认（细节：任务列表 + 验收标准）—— 用户确认后作为 answer 传工具，工具自动进 execute。
6. 用户说「改」→ 只重派生计划（决策不变），重新写字段、重新确认；用户推翻决策本身 → 回到 grill。

# 阶段三 execute 执行验收
1. plan_execute(action=continue) 进入（若工具已自动衔接则直接开始）。
2. 串行按依赖序执行每任务；验收 = 跑 DoD 指定的可观察命令/测试输出，看到结果才算过，自评不算。
3. 每任务用 record 回写状态；与计划不一致用 deviation 记偏差。
4. plan_execute(action=report) 看里程碑（done/failed/blocked/deviations）。
5. 停止条件：计划本身有错 → 停下写清原因（不私自改计划）；3 连败 → 停下汇总；每任务工具调用 ≤10 次，超了记 failed；用户说「结束」→ 收尾。
6. 外部输入缺失（API key/账号/数据）→ 停下批量收集，凑齐再继续。

# 中断与修改
- 改某条已确认决策 → 直接 edit .grill 文件。
- 改计划字段 → section+content 重写，或 edit .plan 文件。
- 重做某阶段 → plan_execute(action=start, phase=grill 或 compile)。
- 彻底重来 → 删 .grill/.plan/.meta 三文件再 start，或换一个 slug。
- 用户改了什么 → 重新确认对应那一层/那一段。

# 状态文件（约定格式，供任何人/agent 消费）
.grill/<slug>.md      三段：Confirmed Decisions / Constraints & Risks / Unresolved Backlog
.plan/<slug>.md       六字段 + 确认记录 + 执行状态 + 偏差记录
.plan/<slug>.meta.json  阶段指针（机器读）`;
}
export function apply(ctx, _config = {}) {
    const config = {
        defaultSlug: 'plan',
        grillDir: '.grill',
        planDir: '.plan',
        autoTrigger: true,
        ..._config,
    };
    const fs = ctx.get('fs');
    if (fs === undefined)
        return;
    const tools = ctx.get('tools');
    if (tools === undefined)
        return;
    const looseCtx = ctx;
    const emit = (name, ...args) => looseCtx.emit(name, ...args);
    const waterfall = (name, ...args) => looseCtx.waterfall(name, ...args);
    const metaPath = (slug) => `${config.planDir}/${slug}.meta.json`;
    const grillPath = (slug) => `${config.grillDir}/${slug}.md`;
    const planPath = (slug) => `${config.planDir}/${slug}.md`;
    const sessionCwd = (exec) => exec?.agent?.session?.header?.cwd;
    function resolvePath(rel, exec) {
        const cwd = sessionCwd(exec);
        return fs.resolve(rel, cwd !== undefined ? { cwd } : undefined);
    }
    async function readFile(rel, exec) {
        const target = await resolvePath(rel, exec);
        if (target === undefined)
            return undefined;
        const info = await fs.stat(target, exec?.signal);
        if (!info) {
            emit('fs/observed', target, { kind: 'absent' }, exec);
            return undefined;
        }
        const content = await fs.readText(target, exec?.signal);
        emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
        return content;
    }
    async function writeFile(rel, content, exec) {
        const target = await resolvePath(rel, exec);
        if (target === undefined)
            return;
        const info = await fs.stat(target, exec?.signal);
        emit('fs/observed', target, info ? { kind: 'present', version: info.version } : { kind: 'absent' }, exec);
        const intent = await waterfall('fs/write-intent', target, exec, () => undefined);
        const outcome = await fs.writeText(target, content, intent, exec?.signal);
        emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
    }
    async function readMeta(slug, exec) {
        try {
            const c = await readFile(metaPath(slug), exec);
            if (!c)
                return undefined;
            return JSON.parse(c);
        }
        catch {
            return undefined;
        }
    }
    async function writeMeta(slug, meta, exec) {
        meta.updatedAt = new Date().toISOString();
        await writeFile(metaPath(slug), JSON.stringify(meta, null, 2), exec);
    }
    function pickSlug(slug) {
        const s = (slug ?? '')
            .trim()
            .replace(/[^A-Za-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (s)
            return s.slice(0, 64);
        return config.defaultSlug;
    }
    function escapeReg(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function hitStopWord(text) {
        const n = text.trim().replace(/[。．.！？!?，,、；;~～]+$/g, '').toLowerCase();
        if (STOP_WORDS.some((w) => n === w.toLowerCase()))
            return true;
        if (/[了吧]$/.test(n)) {
            const m = n.slice(0, -1);
            return STOP_WORDS.some((w) => m === w.toLowerCase());
        }
        return false;
    }
    async function currentPhase(slug, exec) {
        const meta = await readMeta(slug, exec);
        if (meta && meta.phase && PHASES.includes(meta.phase))
            return meta.phase;
        const hasPlan = (await readFile(planPath(slug), exec)) !== undefined;
        const hasGrill = (await readFile(grillPath(slug), exec)) !== undefined;
        if (hasPlan)
            return 'execute';
        if (hasGrill)
            return 'compile';
        return 'grill';
    }
    async function appendGrillRecord(slug, qLabel, answer, exec) {
        const cur = (await readFile(grillPath(slug), exec)) || GRILL_SKELETON;
        const marker = '## Constraints & Risks';
        const index = cur.split('## Confirmed Decisions')[1]?.split('\n').filter((l) => l.startsWith('- Q')).length ?? 0;
        const n = index + 1;
        const block = `- Q${n}：${qLabel}\n- A${n}：${answer.trim()}\n\n`;
        const next = cur.includes(marker) ? cur.replace(marker, block + marker) : cur + '\n' + block;
        await writeFile(grillPath(slug), next, exec);
    }
    async function openCompile(slug, exec) {
        const g = await readFile(grillPath(slug), exec);
        if (!g) {
            return { text: `未找到 ${config.grillDir}/${slug}.md，请先完成「拷问决策」。`, nextAction: 'answer', phase: 'compile', slug };
        }
        const p = await readFile(planPath(slug), exec);
        if (!p)
            await writeFile(planPath(slug), planHead(slug, config.grillDir), exec);
        await writeMeta(slug, { phase: 'compile', slug, compileLayer: 'structure' }, exec);
        return {
            text: '【编译计划】第一层确认（结构）：里程碑分组 + 每里程碑 ≤3 个关键拆解假设 + 依赖骨架。请确认或修改。',
            nextAction: 'answer', phase: 'compile', slug,
        };
    }
    async function resumeCompile(slug, exec) {
        const g = await readFile(grillPath(slug), exec);
        if (!g) {
            return { text: `未找到 ${config.grillDir}/${slug}.md，请先完成「拷问决策」。`, nextAction: 'answer', phase: 'compile', slug };
        }
        const prev = (await readMeta(slug, exec)) || {};
        const layer = prev.compileLayer === 'detail' ? 'detail' : 'structure';
        await writeMeta(slug, { phase: 'compile', slug, compileLayer: layer }, exec);
        return layer === 'structure'
            ? { text: '【编译计划】第一层确认（结构）：里程碑分组 + 每里程碑 ≤3 个关键拆解假设 + 依赖骨架。请确认或修改。', nextAction: 'answer', phase: 'compile', slug }
            : { text: '【编译计划】继续第二层确认（细节）：完整任务列表 + 每任务验收标准，默认通过，仅需回改反对项。请确认或列明反对项。', nextAction: 'answer', phase: 'compile', slug };
    }
    async function openExecute(slug, exec) {
        const p = await readFile(planPath(slug), exec);
        if (!p) {
            return { text: `未找到 ${config.planDir}/${slug}.md，请先完成「编译计划」。`, nextAction: 'answer', phase: 'execute', slug };
        }
        await writeMeta(slug, { phase: 'execute', slug }, exec);
        return {
            text: '【执行验收】开始。逐任务执行、跑可观察验收；用 record 回写状态、deviation 记偏差、action=report 看里程碑；结束说「结束」。',
            nextAction: 'answer', phase: 'execute', slug,
        };
    }
    // ============ grill ============
    async function grillAction(action, slug, answer, question, exec) {
        if (action === 'start') {
            const g = await readFile(grillPath(slug), exec);
            if (!g)
                await writeFile(grillPath(slug), GRILL_SKELETON, exec);
            await writeMeta(slug, { phase: 'grill', slug }, exec);
            const cwd = sessionCwd(exec) ?? '(未知)';
            return {
                text: `【拷问决策】开始（工作目录 ${cwd}，项目 ${slug}）。请主 agent 读取代码库、按依赖序逐题拷问；用 question 参数喂题、answer 参数带回答复；用户说「结束」进入编译阶段。`,
                nextAction: 'answer', phase: 'grill', slug,
            };
        }
        if (action === 'answer') {
            if (!answer || !answer.trim()) {
                return { text: '请提供对上一题的回答。', nextAction: 'answer', phase: 'grill', slug };
            }
            if (hitStopWord(answer)) {
                return await openCompile(slug, exec);
            }
            if (!question || !question.trim()) {
                return { text: '请用 question 参数指定本次回答对应的问题。', nextAction: 'answer', phase: 'grill', slug };
            }
            await appendGrillRecord(slug, question.trim(), answer, exec);
            return { text: '已记录。请继续提问，或说「结束」收尾。', nextAction: 'answer', phase: 'grill', slug };
        }
        return { text: '未知动作。', nextAction: 'answer', phase: 'grill', slug };
    }
    // ============ compile ============
    async function appendPlanSection(slug, section, body, exec) {
        const cur = (await readFile(planPath(slug), exec)) || planHead(slug, config.grillDir);
        const anchor = '## 执行状态';
        const block = `### ${section}\n${body.trim()}\n\n`;
        const next = cur.includes(anchor) ? cur.replace(anchor, block + anchor) : cur + '\n' + block;
        await writeFile(planPath(slug), next, exec);
    }
    async function writePlanSection(slug, section, content, exec) {
        const cur = (await readFile(planPath(slug), exec)) || planHead(slug, config.grillDir);
        const lines = cur.split('\n');
        const hdr = lines.findIndex((l) => l.trim() === `## ${section}`);
        if (hdr < 0) {
            await writeFile(planPath(slug), cur + `\n## ${section}\n\n${content.trim()}\n`, exec);
            return;
        }
        let end = lines.length;
        for (let i = hdr + 1; i < lines.length; i++) {
            if (/^##\s/.test(lines[i])) {
                end = i;
                break;
            }
        }
        const next = [...lines.slice(0, hdr + 1), '', content.trim(), '', ...lines.slice(end)].join('\n');
        await writeFile(planPath(slug), next, exec);
    }
    async function compileAction(action, slug, answer, exec) {
        if (action === 'start')
            return await openCompile(slug, exec);
        if (action === 'continue')
            return await resumeCompile(slug, exec);
        if (action === 'answer') {
            if (!answer || !answer.trim()) {
                return { text: '请提供确认/修改意见。', nextAction: 'answer', phase: 'compile', slug };
            }
            if (hitStopWord(answer)) {
                return await openExecute(slug, exec);
            }
            const meta = (await readMeta(slug, exec)) || { phase: 'compile', slug, compileLayer: 'structure' };
            if (meta.compileLayer === 'structure') {
                await appendPlanSection(slug, '结构确认', answer, exec);
                await writeMeta(slug, { phase: 'compile', slug, compileLayer: 'detail' }, exec);
                return {
                    text: '结构已记录。第二层确认（细节）：完整任务列表 + 每任务验收标准，默认通过，仅需回改反对项。请确认或列明反对项。',
                    nextAction: 'answer', phase: 'compile', slug,
                };
            }
            await appendPlanSection(slug, '细节确认', answer, exec);
            return await openExecute(slug, exec);
        }
        return { text: '未知动作。', nextAction: 'answer', phase: 'compile', slug };
    }
    // ============ execute ============
    async function buildReport(slug, exec) {
        const plan = (await readFile(planPath(slug), exec)) || '';
        const section = plan.split('## 执行状态')[1] ?? '';
        const lines = section.split('\n');
        const latest = {};
        let checkDone = 0;
        let checkTodo = 0;
        for (const line of lines) {
            const m = line.match(/^\s*[-*]\s+([^\s:：]+)\s*[:：]\s*(doing|done|failed|blocked|todo)\b\s*(.*)$/);
            if (m) {
                latest[m[1]] = { status: m[2], reason: m[3].trim().replace(/^[:：]\s*/, '') };
                continue;
            }
            if (/^\s*[-*]\s*\[x\]/i.test(line))
                checkDone += 1;
            else if (/^\s*[-*]\s*\[ \]/.test(line))
                checkTodo += 1;
        }
        const counts = { done: 0, doing: 0, todo: 0, failed: 0, blocked: 0 };
        const failed = [];
        const blocked = [];
        for (const [id, rec] of Object.entries(latest)) {
            counts[rec.status] = (counts[rec.status] ?? 0) + 1;
            if (rec.status === 'failed')
                failed.push(`${id}: ${rec.reason || '(无描述)'}`);
            if (rec.status === 'blocked')
                blocked.push(`${id}: ${rec.reason || '(无描述)'}`);
        }
        counts.done += checkDone;
        counts.todo += checkTodo;
        const devSection = plan.split('## 偏差记录')[1] ?? '';
        const deviations = devSection
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('-'))
            .map((l) => l.replace(/^-\s*/, ''))
            .filter(Boolean);
        if (Object.keys(latest).length + checkDone + checkTodo + deviations.length === 0) {
            return '【里程碑报告】\n- 尚无执行状态记录。主 agent 可用 record 参数写入（如 record="T1 done"），或直接在计划文件「执行状态」节写状态。';
        }
        return [
            '【里程碑报告】',
            `- done: ${counts.done}`,
            `- doing: ${counts.doing}`,
            `- todo: ${counts.todo}`,
            `- failed: ${counts.failed}${failed.length ? '（' + failed.join('；') + '）' : ''}`,
            `- blocked: ${counts.blocked}${blocked.length ? '（' + blocked.join('；') + '）' : ''}`,
            `- deviations: ${deviations.length}${deviations.length ? '（' + deviations.join('；') + '）' : ''}`,
        ].join('\n');
    }
    async function recordStatus(slug, record, exec) {
        const m = record.trim().match(/^([^\s:：]+)\s*[:：]?\s*(doing|done|failed|blocked|todo)\b\s*(.*)$/);
        if (!m)
            return `无法解析记录「${record}」，格式应为「任务ID 状态 [原因]」，状态 ∈ doing/done/failed/blocked/todo。`;
        const [, id, status] = m;
        const reason = m[3].trim().replace(/^[:：]\s*/, '');
        const cur = (await readFile(planPath(slug), exec)) || planHead(slug, config.grillDir);
        const anchor = '## 执行状态';
        const line = `- ${id}: ${status}${reason.trim() ? ' ' + reason.trim() : ''}`;
        const lines = cur.split('\n');
        const idx = lines.findIndex((l) => new RegExp(`^\\s*[-*]\\s+${escapeReg(id)}\\s*[:：]`).test(l));
        let next;
        if (idx >= 0) {
            lines[idx] = line;
            next = lines.join('\n');
        }
        else if (cur.includes(anchor)) {
            next = cur.replace(anchor, anchor + '\n' + line);
        }
        else {
            next = cur + '\n' + anchor + '\n' + line;
        }
        await writeFile(planPath(slug), next, exec);
        return `已记录：${id} → ${status}`;
    }
    async function recordDeviation(slug, text, exec) {
        const cur = (await readFile(planPath(slug), exec)) || planHead(slug, config.grillDir);
        const anchor = '## 偏差记录';
        const line = `- ${text.trim()}\n`;
        const next = cur.includes(anchor) ? cur.replace(anchor, anchor + '\n' + line) : cur + '\n' + anchor + '\n' + line;
        await writeFile(planPath(slug), next, exec);
        return `已记录偏差：${text.trim()}`;
    }
    async function executeAction(action, slug, answer, record, deviation, exec) {
        if (action === 'start' || action === 'continue')
            return await openExecute(slug, exec);
        if (record && record.trim()) {
            const msg = await recordStatus(slug, record, exec);
            return { text: msg, nextAction: 'answer', phase: 'execute', slug };
        }
        if (deviation && deviation.trim()) {
            const msg = await recordDeviation(slug, deviation, exec);
            return { text: msg, nextAction: 'answer', phase: 'execute', slug };
        }
        if (action === 'answer') {
            if (!answer) {
                return { text: '请回复「结束」收尾，或用 record 回写状态、deviation 记偏差、action=report 看里程碑。', nextAction: 'answer', phase: 'execute', slug };
            }
            if (hitStopWord(answer)) {
                await writeMeta(slug, { phase: 'done', slug }, exec);
                return { text: '【执行验收】已停止，阶段标记为 done。', nextAction: 'stop', phase: 'done', slug };
            }
            return { text: '请继续执行下一个任务，或用 record 回写状态、deviation 记偏差、action=report 查看里程碑。', nextAction: 'answer', phase: 'execute', slug };
        }
        return { text: '未知动作。', nextAction: 'answer', phase: 'execute', slug };
    }
    // ============ 总入口 ============
    async function run(args, exec) {
        const action = typeof args.action === 'string' ? args.action : 'start';
        const slug = pickSlug(typeof args.slug === 'string' ? args.slug : undefined);
        const answer = typeof args.answer === 'string' ? args.answer : undefined;
        const record = typeof args.record === 'string' ? args.record : undefined;
        const question = typeof args.question === 'string' ? args.question : undefined;
        const section = typeof args.section === 'string' ? args.section.trim() : undefined;
        const content = typeof args.content === 'string' ? args.content : undefined;
        const deviation = typeof args.deviation === 'string' ? args.deviation : undefined;
        const phase = typeof args.phase === 'string' ? args.phase : undefined;
        if (action === 'report') {
            const meta = await readMeta(slug, exec);
            const ph = phase && PHASES.includes(phase) ? phase : meta && meta.phase ? meta.phase : await currentPhase(slug, exec);
            if (ph === 'execute') {
                return { text: await buildReport(slug, exec), nextAction: 'answer', phase: 'execute', slug };
            }
            return { text: `当前阶段: ${ph} | slug: ${slug}`, nextAction: 'continue', phase: ph, slug };
        }
        if (action === 'stop') {
            await writeMeta(slug, { phase: 'done', slug }, exec);
            return { text: '已安全停止，状态写回。', nextAction: 'stop', phase: 'done', slug };
        }
        if (section && content !== undefined) {
            if (!VALID_SECTIONS.includes(section)) {
                return { text: `未知计划字段「${section}」，可用：${VALID_SECTIONS.join(' / ')}。`, nextAction: 'continue', phase: phase ?? 'compile', slug };
            }
            await writePlanSection(slug, section, content, exec);
            return { text: `已写入计划字段「${section}」。`, nextAction: 'continue', phase: phase ?? 'compile', slug };
        }
        let phaseNow;
        if (phase && PHASES.includes(phase)) {
            phaseNow = phase;
        }
        else if (action === 'start') {
            // 无显式 phase 的 start = 新建：绝不静默覆盖/接管已有计划
            const meta = await readMeta(slug, exec);
            const hasGrill = (await readFile(grillPath(slug), exec)) !== undefined;
            const hasPlan = (await readFile(planPath(slug), exec)) !== undefined;
            if (meta || hasGrill || hasPlan) {
                const ph = meta?.phase && PHASES.includes(meta.phase) ? meta.phase : hasPlan ? 'execute' : hasGrill ? 'compile' : 'grill';
                const cwd = sessionCwd(exec) ?? '(未知)';
                return {
                    text: `检测到 ${cwd} 下已存在计划「${slug}」（阶段 ${ph}）。start 不会覆盖已有计划：续跑请用 action=continue；新建请换一个 slug；彻底重来请先删除 .grill/ 与 .plan/ 下该计划的文件。`,
                    nextAction: 'continue', phase: ph, slug,
                };
            }
            phaseNow = 'grill';
        }
        else {
            phaseNow = await currentPhase(slug, exec);
        }
        if (phaseNow === 'grill')
            return await grillAction(action, slug, answer, question, exec);
        if (phaseNow === 'compile')
            return await compileAction(action, slug, answer, exec);
        if (phaseNow === 'execute')
            return await executeAction(action, slug, answer, record, deviation, exec);
        if (phaseNow === 'done')
            return { text: '流程已完成。如需重跑：换一个 slug 新建，或删除 .grill/.plan 文件后 action=start。', nextAction: 'start', phase: 'done', slug };
        return { text: '无法判定阶段。', nextAction: 'start', phase: 'grill', slug };
    }
    const disposeTool = tools.register({
        name: 'plan_execute',
        description: (config.autoTrigger
            ? '「计划实施」三合一编排引擎的记账本（状态机）：拷问决策(grill)→编译计划(compile)→执行验收(execute)。先用 skill 工具加载 plan-workflow 获取完整流程与提问策略，再驱动本工具。触发：用户提出需求模糊/多步骤/项目级的新任务时，默认先调用本工具进入「拷问决策」确认需求，未经确认不得直接动手；用户说「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」时同样调用；简单明确、一步可完成的请求不必调用；用户明确说「直接做/不用确认/跳过流程」时跳过本流程。多步驱动(action=start/answer/continue/report/stop)；主 agent 用 question 喂题、section+content 写计划字段、record/deviation 回写执行状态。'
            : '「计划实施」三合一编排引擎的记账本（状态机）：拷问决策(grill)→编译计划(compile)→执行验收(execute)。先用 skill 工具加载 plan-workflow 获取完整流程与提问策略，再驱动本工具。触发：仅当用户说「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」时调用本工具；用户明确说「直接做/不用确认/跳过流程」时跳过本流程。多步驱动(action=start/answer/continue/report/stop)；主 agent 用 question 喂题、section+content 写计划字段、record/deviation 回写执行状态。'),
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
            return await run(args, exec);
        },
    });
    ctx.effect(() => disposeTool);
    // 注册编排大脑 skill（可选：无 skills 服务时跳过，工具仍可被模型即兴驱动）。
    const skills = ctx.get('skills');
    if (skills !== undefined) {
        const disposeSkill = skills.register({
            name: 'plan-workflow',
            description: '「计划实施」三合一编排流程的大脑：拷问决策→编译计划→执行验收，配合 plan_execute 工具落盘。',
            whenToUse: config.autoTrigger
                ? '用户提出需求模糊、多步骤或项目级的新任务时（除非用户明确说「直接做/不用确认/跳过流程」），或说出「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」时，加载本 skill 并驱动 plan_execute 工具。'
                : '当用户说「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」时加载本 skill 并驱动 plan_execute 工具。',
            source: 'bundled',
            content: buildSkillContent(config.autoTrigger),
        });
        ctx.effect(() => disposeSkill);
    }
}
