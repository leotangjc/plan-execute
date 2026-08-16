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
import { PHASES, blockedMessage } from './state-machine.js';
import { buildSkillContent } from './skill-content.js';
import { VERSION } from './version.js';
export const name = 'dsh-plan-execute';
/** Services required before this plugin can register. */
export const inject = ['tools'];
/** 当前元数据 schema 版本。 */
const META_SCHEMA = 2;
const ADVANCE_WORDS = ['结束', '够了', '结束拷问', 'stop', 'done'];
const PAUSE_WORDS = ['暂停', '停', '先暂停', '先停'];
const TRAILING_PARTICLES = /[了吧啊呀哈呢哦嘛啦咯喽呗哟哇]+$/;
const GRILL_SKELETON = '# 拷问决策记录\n\n## Confirmed Decisions\n\n## Constraints & Risks\n\n## Unresolved Backlog\n';
const VALID_SECTIONS = ['任务列表', '依赖图', '验收标准', '风险与假设', '未决项映射', '里程碑'];
/** 运行期可选阶段（参数 phase 可用值；done 是终态，不接受显式指定）。 */
const SELECTABLE_PHASES = ['grill', 'compile', 'execute'];
function planHead(slug, grillDir) {
    return `# 执行计划: ${slug}\n\n> 输入来源: ${grillDir}/${slug}.md\n\n## 任务列表\n\n## 依赖图\n\n## 验收标准\n\n## 风险与假设\n\n## 未决项映射\n\n## 里程碑\n\n## 确认记录\n\n## 执行状态\n\n## 偏差记录\n`;
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
    // 沙箱策略服务（存在时）：写文件必须带 per-session 策略（workspaceRoot=会话 cwd），
    // 否则沙箱回退部署默认策略、不含会话工作区 → workspace-write 下写被拒。
    const policySvc = ctx.get('sandboxPolicy');
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
        const policy = policySvc?.resolve({ session: exec?.agent?.session });
        const cwd = policy?.workspaceRoot ?? sessionCwd(exec);
        const target = await fs.resolve(rel, cwd !== undefined ? { cwd } : undefined);
        // V-06 修复：写路径解析失败不再静默 return（否则工具「已记录」但磁盘没写）。
        // 指针/日志等尽力而为调用点用 .catch 兜底；主路径抛错由 run() 转成可见错误文本。
        if (target === undefined) {
            throw new Error(`无法解析目标路径「${rel}」（可能超出工作区或沙箱拒绝）`);
        }
        const info = await fs.stat(target, exec?.signal);
        emit('fs/observed', target, info ? { kind: 'present', version: info.version } : { kind: 'absent' }, exec);
        const intent = await waterfall('fs/write-intent', target, exec, () => undefined);
        const outcome = await fs.writeText(target, content, intent, exec?.signal, policy);
        emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
    }
    // —— 活动 slug 指针：非 start 调用漏传 slug 时兜底用「最近一次的计划」，避免落默认 plan / 阶段错乱 ——
    const currentSlugPath = () => `${config.planDir}/.current`;
    async function writeCurrentSlug(value, exec) {
        await writeFile(currentSlugPath(), value, exec);
    }
    async function readCurrentSlug(exec) {
        return (await readFile(currentSlugPath(), exec))?.trim();
    }
    /** 指针兜底：仅当指针所指计划确实存在状态文件时才用，否则回默认（防过期/静默错计划）。 */
    async function pointerFallback(exec) {
        const current = await readCurrentSlug(exec);
        if (current) {
            // V-08 修复：指针内容先过 pickSlug 清洗（防手改/旧版写入的穿越字符），再校验状态存在
            const clean = pickSlug(current);
            if (clean !== pickSlug(undefined)) {
                const hasGrill = (await readFile(grillPath(clean), exec)) !== undefined;
                const hasPlan = (await readFile(planPath(clean), exec)) !== undefined;
                if (hasGrill || hasPlan)
                    return clean;
            }
        }
        return pickSlug(undefined);
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
        // 合并语义（V-01 修复）：阶段转换/收尾/重开不再用全新对象覆盖，tasks/deviations 快照保留。
        const raw = await readFile(metaPath(slug), exec);
        let prev = {};
        if (raw !== undefined) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    prev = parsed;
                }
                else {
                    // 损坏（非对象）：备份原文后以空 prev 重建，不静默覆盖（V-02 修复）
                    await writeFile(`${metaPath(slug)}.corrupt-${Date.now()}`, raw, exec).catch(() => { });
                }
            }
            catch {
                // JSON 解析失败（手改坏/崩溃半写）：备份原文，不静默覆盖
                await writeFile(`${metaPath(slug)}.corrupt-${Date.now()}`, raw, exec).catch(() => { });
            }
        }
        const next = { ...prev, ...meta, updatedAt: new Date().toISOString(), schema: META_SCHEMA };
        await writeFile(metaPath(slug), JSON.stringify(next, null, 2), exec);
    }
    /** 短哈希（djb2，8 位 hex）：纯非 ASCII 名（如中文）兜底为可读唯一 slug。8 位在 5000 个项目下碰撞 ≈0.3%。 */
    function hash8(text) {
        let h = 5381;
        for (const ch of text)
            h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
        return h.toString(16).padStart(8, '0').slice(0, 8);
    }
    function pickSlug(slug) {
        const raw = (slug ?? '').trim();
        const s = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
        if (s)
            return s.slice(0, 64);
        // 空/缺省 → 默认 plan；纯非 ASCII（如中文项目名）→ plan-短哈希，避免全部坍缩成 plan 互相覆盖
        return raw ? `plan-${hash8(raw)}` : config.defaultSlug;
    }
    function escapeReg(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function hitWord(text, words) {
        const lower = words.map((w) => w.toLowerCase());
        // 词表中的纯英文词（stop/done）：支持「够了！stop」这类中英混合口语的尾部剥离
        const enWords = lower.filter((w) => /^[a-z]+$/.test(w));
        // 尾部标点（全角/半角）：每轮先剥，处理「够了！stop」剥掉 stop 后暴露的「！」
        const TAIL_PUNCT = /[。．.！？!?，,、；;~～]+$/;
        let n = text.trim().replace(TAIL_PUNCT, '').toLowerCase();
        // 每剥一步都查一次词表（含重复词），防止「够了呀」剥掉词尾“了”后失配
        for (let i = 0; i < 5; i++) {
            n = n.replace(TAIL_PUNCT, '');
            if (lower.includes(n))
                return true;
            if (lower.some((w) => n === w.repeat(2) || n === w.repeat(3)))
                return true;
            // 口语省略词尾「了」：够啦 → 够 ≈ 够了
            if (lower.some((w) => w.endsWith('了') && n === w.slice(0, -1)))
                return true;
            // 尾部英文停止词：够了！stop → 剥 stop → 剥标点 → 够了（保守：仅尾部、仅整词）
            const enTail = enWords.find((w) => n.length > w.length && n.endsWith(w));
            if (enTail) {
                n = n.slice(0, -enTail.length);
                continue;
            }
            if (TRAILING_PARTICLES.test(n))
                n = n.slice(0, -1);
            else if (n.endsWith('一下'))
                n = n.slice(0, -2);
            else
                break;
        }
        return (lower.includes(n) ||
            lower.some((w) => n === w.repeat(2) || n === w.repeat(3)) ||
            lower.some((w) => w.endsWith('了') && n === w.slice(0, -1)));
    }
    function hitAdvance(text) {
        return hitWord(text, ADVANCE_WORDS);
    }
    function hitPause(text) {
        return hitWord(text, PAUSE_WORDS);
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
        const confirmed = cur.split('## Confirmed Decisions')[1]?.split('## Constraints & Risks')[0] ?? '';
        const index = confirmed.split('\n').filter((l) => /^- Q\d+[：:]/.test(l.trim())).length;
        const n = index + 1;
        const block = `- Q${n}：${qLabel}\n- A${n}：${answer.trim()}\n\n`;
        const next = cur.includes(marker) ? cur.replace(marker, block + marker) : cur + '\n' + block;
        await writeFile(grillPath(slug), next, exec);
    }
    /** 统计 .grill 的 Unresolved Backlog 未决项数（节内非空 - 行）。 */
    function countBacklog(grill) {
        const rest = grill.split('## Unresolved Backlog')[1] ?? '';
        const section = rest.split(/^##\s/m)[0] ?? '';
        return section.split('\n').map((l) => l.trim()).filter((l) => l.length > 1 && l.startsWith('-') && !/^- ?(\[[xX✓]\]|[✓✔])/.test(l)).length;
    }
    async function openCompile(slug, exec) {
        const g = await readFile(grillPath(slug), exec);
        if (!g) {
            return { text: `未找到 ${config.grillDir}/${slug}.md，请先完成「拷问决策」。`, nextAction: 'answer', phase: 'compile', slug };
        }
        const open = countBacklog(g);
        if (open > 0) {
            return {
                text: `【编译计划】暂缓：Unresolved Backlog 尚有 ${open} 项未决。先与用户确认这些项：已处理/忽略的可把行删掉或标成「- [x] …」，需带进计划的写进「未决项映射」；处理完（backlog 无未标 [x] 的项）后再说「结束」进入编译。`,
                nextAction: 'answer', phase: 'compile', slug,
            };
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
        // V-05 修复：只放行「续跑 execute」或「compile 两层确认完成（compileLayer=detail）」，
        // 防止显式 phase=execute 在未确认时直达执行（未确认即动手的坏状态）。
        const meta = await readMeta(slug, exec);
        const metaPhase = meta?.phase;
        const layer = meta?.compileLayer;
        if (metaPhase !== 'execute' && !(metaPhase === 'compile' && layer === 'detail')) {
            return {
                text: `【执行验收】暂缓：当前阶段 ${metaPhase ?? '（无状态）'}，尚未完成「编译计划」的两层确认。请先完成结构+细节两层确认，或用 action=continue 续跑已确认的计划。`,
                nextAction: 'answer', phase: 'compile', slug,
            };
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
            // V-03 修复：带 question 的回答 = 内容语义（即使文本碰巧是「够了/stop/结束」也按 Q/A 记录，不触发控制词）；
            // 不带 question 的 answer 才是控制语义（「结束」推进 / 「暂停」停留）。
            const hasQuestion = question !== undefined && question.trim() !== '';
            if (!hasQuestion) {
                if (hitAdvance(answer)) {
                    return await openCompile(slug, exec);
                }
                if (hitPause(answer)) {
                    return {
                        text: '已暂停（停留在拷问阶段）。若有未决问题，先与用户确认并把未决项写入 .grill 的 Unresolved Backlog；想继续拷问就继续提问，想结束本阶段说「结束」。',
                        nextAction: 'answer', phase: 'grill', slug,
                    };
                }
                return { text: '请用 question 参数指定本次回答对应的问题。', nextAction: 'answer', phase: 'grill', slug };
            }
            await appendGrillRecord(slug, question.trim(), answer, exec);
            return { text: '已记录。请继续提问，或说「结束」收尾。', nextAction: 'answer', phase: 'grill', slug };
        }
        if (action === 'stop') {
            // V-04 修复：grill 阶段 stop = 停留在当前阶段（不置 done，不锁死流程）
            return { text: '已停止（停留在拷问阶段）。进度已落盘；想继续拷问直接提问，想结束本阶段说「结束」。', nextAction: 'answer', phase: 'grill', slug };
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
            if (hitAdvance(answer)) {
                return await openExecute(slug, exec);
            }
            if (hitPause(answer)) {
                return { text: '已暂停（停留在编译阶段）。先与用户确认未决项，确认后说「结束」进入执行。', nextAction: 'answer', phase: 'compile', slug };
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
        if (action === 'stop') {
            // V-04 修复：compile 阶段 stop = 停留在当前阶段（不置 done）
            return { text: '已停止（停留在编译阶段）。进度已落盘；想继续确认说「继续」，想结束说「结束」。', nextAction: 'answer', phase: 'compile', slug };
        }
        return { text: '未知动作。', nextAction: 'answer', phase: 'compile', slug };
    }
    // ============ execute ============
    async function buildReport(slug, exec) {
        // 完整版 P1A：统计只来自 meta.json 结构化快照（record/deviation 写入），
        // 不再解析 md —— 执行状态/偏差记录节仅展示，任何手改都不影响报告。
        const meta = await readMeta(slug, exec);
        // schema 守卫：明确比当前 schema 旧的元数据 → 不静默走老逻辑，提示重写
        if (meta && meta.schema !== undefined && meta.schema < META_SCHEMA) {
            return `【里程碑报告】v${VERSION}\n- 此计划由旧版创建（schema ${meta.schema}，无结构化快照）。请用 record 参数重新写入任务状态（如 record="T1 done"）后查看报告。`;
        }
        // 形状守卫（V-06 补充）：meta 可能被手改坏——tasks 非对象/deviations 非数组/单条记录非对象都跳过，不抛错
        const tasks = meta?.tasks && typeof meta.tasks === 'object' && !Array.isArray(meta.tasks) ? meta.tasks : {};
        const deviations = Array.isArray(meta?.deviations) ? meta.deviations : [];
        const counts = { done: 0, doing: 0, todo: 0, failed: 0, blocked: 0 };
        const failed = [];
        const blocked = [];
        const VALID_STATUSES = ['done', 'doing', 'todo', 'failed', 'blocked'];
        for (const [id, rec] of Object.entries(tasks)) {
            if (!rec || typeof rec !== 'object' || typeof rec.status !== 'string')
                continue;
            const status = rec.status;
            if (!VALID_STATUSES.includes(status))
                continue;
            counts[status] = (counts[status] ?? 0) + 1;
            const reason = rec.reason;
            if (status === 'failed')
                failed.push(`${id}: ${reason || '(无描述)'}`);
            if (status === 'blocked')
                blocked.push(`${id}: ${reason || '(无描述)'}`);
        }
        if (Object.keys(tasks).length + deviations.length === 0) {
            return `【里程碑报告】v${VERSION}\n- 尚无执行状态记录。请用 record 参数写入任务状态（如 record="T1 done"）；「执行状态」节由工具写，勿手改。`;
        }
        return [
            `【里程碑报告】v${VERSION}`,
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
        const reason = m[3].trim().replace(/[\r\n]+/g, ' ').replace(/^[\s，,、；;:：]+/, '');
        // V-07 修复：拒绝保留名（原型污染）与超长 id
        if (id.length > 32 || id === '__proto__' || id === 'prototype' || id === 'constructor') {
            return `任务 ID「${id}」不合法：长度 ≤32 且不得为保留名（__proto__/prototype/constructor）。`;
        }
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
        // 结构化快照：同步写进 meta.json（report 优先读它，免疫 md 执行状态手改）
        const prev = (await readMeta(slug, exec)) || {};
        const prevTasks = prev.tasks && typeof prev.tasks === 'object' && !Array.isArray(prev.tasks) ? prev.tasks : {};
        const tasks = { ...prevTasks };
        tasks[id] = { status, reason };
        await writeMeta(slug, { ...prev, phase: prev.phase || 'execute', tasks }, exec);
        const c = { done: 0, doing: 0, todo: 0, failed: 0, blocked: 0 };
        for (const r of Object.values(tasks)) {
            if (r && typeof r === 'object' && typeof r.status === 'string')
                c[r.status] = (c[r.status] ?? 0) + 1;
        }
        return `已记录：${id} → ${status}（当前 done ${c.done} · failed ${c.failed} · blocked ${c.blocked} · todo ${c.todo} · doing ${c.doing}）`;
    }
    async function recordDeviation(slug, text, exec) {
        const clean = text.trim().replace(/[\r\n]+/g, ' ');
        const cur = (await readFile(planPath(slug), exec)) || planHead(slug, config.grillDir);
        const anchor = '## 偏差记录';
        const line = `- ${clean}\n`;
        const next = cur.includes(anchor) ? cur.replace(anchor, anchor + '\n' + line) : cur + '\n' + anchor + '\n' + line;
        await writeFile(planPath(slug), next, exec);
        // 结构化：同步进 meta.json（report 唯一事实源）
        const prev = (await readMeta(slug, exec)) || {};
        const deviations = Array.isArray(prev.deviations) ? [...prev.deviations, clean] : [clean];
        await writeMeta(slug, { ...prev, phase: prev.phase || 'execute', deviations }, exec);
        return `已记录偏差：${clean}（累计 ${deviations.length} 条）`;
    }
    async function executeAction(action, slug, answer, record, deviation, exec) {
        if (action === 'stop') {
            // V-04 修复：execute 阶段 stop = 安全收尾置 done（快照由 writeMeta 合并保留）
            await writeMeta(slug, { phase: 'done', slug }, exec);
            return { text: '已安全停止，阶段标记为 done（进度快照已保留）。', nextAction: 'stop', phase: 'done', slug };
        }
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
            if (hitAdvance(answer)) {
                await writeMeta(slug, { phase: 'done', slug }, exec);
                return { text: '【执行验收】已结束，阶段标记为 done。', nextAction: 'stop', phase: 'done', slug };
            }
            if (hitPause(answer)) {
                return { text: '已暂停（停留在执行阶段）。进度已落盘；想继续执行就继续，想收尾说「结束」。', nextAction: 'answer', phase: 'execute', slug };
            }
            return { text: '请继续执行下一个任务，或用 record 回写状态、deviation 记偏差、action=report 查看里程碑。', nextAction: 'answer', phase: 'execute', slug };
        }
        return { text: '未知动作。', nextAction: 'answer', phase: 'execute', slug };
    }
    // ============ 总入口 ============
    async function runCore(args, exec) {
        const action = typeof args.action === 'string' ? args.action : 'start';
        const explicitSlug = typeof args.slug === 'string' && args.slug.trim() !== '' ? args.slug : undefined;
        // slug 解析：start 无 slug → 默认；显式 → 用之并刷新指针；非 start 无 slug → 指针兜底（校验状态存在），否则默认。
        const slug = action === 'start' && explicitSlug === undefined
            ? pickSlug(undefined)
            : explicitSlug !== undefined
                ? pickSlug(explicitSlug)
                : await pointerFallback(exec);
        // 记录最近一次活动的计划（start 或显式给 slug 时写；指针是兜底，写失败不影响主流程）
        if (explicitSlug !== undefined || action === 'start') {
            await writeCurrentSlug(slug, exec).catch(() => { });
        }
        const answer = typeof args.answer === 'string' ? args.answer : undefined;
        const record = typeof args.record === 'string' ? args.record : undefined;
        const question = typeof args.question === 'string' ? args.question : undefined;
        const section = typeof args.section === 'string' ? args.section.trim() : undefined;
        const content = typeof args.content === 'string' ? args.content : undefined;
        const deviation = typeof args.deviation === 'string' ? args.deviation : undefined;
        const phase = typeof args.phase === 'string' ? args.phase : undefined;
        // —— 参数组合前置校验：错误组合立即响亮失败，不产生坏状态 ——
        if (section !== undefined && content === undefined) {
            return { text: '参数错误：section 需要搭配 content 一起传。', nextAction: 'continue', phase: phase ?? 'compile', slug };
        }
        if (content !== undefined && section === undefined) {
            return { text: '参数错误：content 需要搭配 section 一起传。', nextAction: 'continue', phase: phase ?? 'compile', slug };
        }
        if (record !== undefined && section !== undefined) {
            return { text: '参数错误：record（记任务状态）与 section（写计划字段）不能同时使用。', nextAction: 'answer', phase: phase ?? 'execute', slug };
        }
        if (record !== undefined && deviation !== undefined) {
            return { text: '参数错误：record 与 deviation 不能同时使用，请分开调用。', nextAction: 'answer', phase: phase ?? 'execute', slug };
        }
        if (action === 'report') {
            const meta = await readMeta(slug, exec);
            const ph = phase && SELECTABLE_PHASES.includes(phase) ? phase : meta && meta.phase ? meta.phase : await currentPhase(slug, exec);
            if (ph === 'execute') {
                return { text: await buildReport(slug, exec), nextAction: 'answer', phase: 'execute', slug };
            }
            return { text: `当前阶段: ${ph} | slug: ${slug}`, nextAction: 'continue', phase: ph, slug };
        }
        // V-04 修复：action=stop 不再早退置 done——交给状态机表（grill/compile 停留、execute 收尾、done 拦截），
        // 杜绝「grill/compile 误用 stop = 流程锁死」与表死代码。
        if (section && content !== undefined) {
            if (!VALID_SECTIONS.includes(section)) {
                return { text: `未知计划字段「${section}」，可用：${VALID_SECTIONS.join(' / ')}。`, nextAction: 'continue', phase: phase ?? 'compile', slug };
            }
            // V-05 修复：计划字段只在编译/执行阶段可写（防 grill 阶段绕过守门凭空建计划）
            const sectionPhase = phase && SELECTABLE_PHASES.includes(phase) ? phase : await currentPhase(slug, exec);
            if (sectionPhase !== 'compile' && sectionPhase !== 'execute') {
                return {
                    text: `参数错误：计划字段「${section}」只能在编译/执行阶段写入（当前阶段 ${sectionPhase}）。`,
                    nextAction: 'continue', phase: sectionPhase, slug,
                };
            }
            await writePlanSection(slug, section, content, exec);
            return { text: `已写入计划字段「${section}」。`, nextAction: 'continue', phase: sectionPhase, slug };
        }
        let phaseNow;
        if (phase && SELECTABLE_PHASES.includes(phase)) {
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
            // 兼容旧版：纯中文项目名曾坍缩为 defaultSlug（'plan'）——新哈希 slug 无自身状态但旧 plan 有状态时提示续跑入口
            if (/^plan-[0-9a-f]{6,8}$/.test(slug) && slug !== config.defaultSlug) {
                const legacyHasGrill = (await readFile(grillPath(config.defaultSlug), exec)) !== undefined;
                const legacyHasPlan = (await readFile(planPath(config.defaultSlug), exec)) !== undefined;
                if (legacyHasGrill || legacyHasPlan) {
                    const ph = legacyHasPlan ? 'execute' : legacyHasGrill ? 'compile' : 'grill';
                    return {
                        text: `检测到旧版默认计划「${config.defaultSlug}」的状态文件（${config.grillDir}/${config.defaultSlug}.md 等）——可能是旧版中文项目名落盘的。想续跑旧状态请显式传 slug=${config.defaultSlug} 并用 action=continue；想新建本计划「${slug}」请用 action=start 并显式带 phase=grill（否则会重复此提示）。`,
                        nextAction: 'continue', phase: ph, slug,
                    };
                }
            }
            phaseNow = 'grill';
        }
        else {
            phaseNow = await currentPhase(slug, exec);
        }
        // 显式状态机表：查合法性矩阵，被拦截的组合给明确提示（取代散落的「未知动作。」）
        const blocked = blockedMessage(phaseNow, action);
        if (blocked !== undefined) {
            return { text: blocked, nextAction: 'continue', phase: phaseNow, slug };
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
    // 审计日志：每次调用 append 一行到 .plan/<slug>.log（尽力而为，写失败不影响主流程；保留最近 500 行防无限膨胀）
    async function appendLog(action, result, exec) {
        const line = `${new Date().toISOString()} | ${action} | ${result.slug} | →${result.phase} | ${result.text.slice(0, 60).replace(/\n/g, ' ')}\n`;
        const prev = (await readFile(`${config.planDir}/${result.slug}.log`, exec)) || '';
        const lines = (prev ? prev.split('\n') : []).filter((l) => l.trim() !== '');
        lines.push(line.trimEnd());
        await writeFile(`${config.planDir}/${result.slug}.log`, lines.slice(-500).join('\n') + '\n', exec);
    }
    async function run(args, exec) {
        let result;
        try {
            result = await runCore(args, exec);
        }
        catch (err) {
            // V-06 修复：写盘/解析失败不再静默成功，转成可见错误文本（工具不抛、不撒谎）
            const slug = typeof args.slug === 'string' && args.slug.trim() !== '' ? pickSlug(args.slug) : pickSlug(undefined);
            result = {
                text: `【写入失败】${err instanceof Error ? err.message : String(err)}。状态未落盘，请检查工作目录与沙箱权限后重试。`,
                nextAction: 'answer',
                phase: 'grill',
                slug,
            };
        }
        // V-08 修复：非 start 且漏传 slug 时，若兜底命中非默认计划，明示所用 slug，防串计划
        const act = typeof args.action === 'string' ? args.action : 'start';
        const explicitSlug = typeof args.slug === 'string' && args.slug.trim() !== '';
        if (!explicitSlug && act !== 'start' && result.slug !== config.defaultSlug) {
            result.text = `（沿用最近计划 ${result.slug}；多计划请显式传 slug）\n` + result.text;
        }
        await appendLog(act, result, exec).catch(() => { });
        return result;
    }
    const disposeTool = tools.register({
        name: 'plan_execute',
        description: (config.autoTrigger
            ? '「计划实施」三合一编排引擎的记账本（状态机）：拷问决策(grill)→编译计划(compile)→执行验收(execute)。先用 skill 工具加载 plan-workflow 获取完整流程与提问策略，再驱动本工具。触发：用户提出需求模糊/多步骤/项目级的新任务时，默认先调用本工具进入「拷问决策」确认需求，未经确认不得直接动手；用户说「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」时同样调用；简单明确、一步可完成的请求不必调用；用户明确说「直接做/不用确认/跳过流程」时跳过本流程。多步驱动(action=start/answer/continue/report/stop)；说「结束」结束当前阶段，说「暂停」停留在本阶段；主 agent 用 question 喂题、section+content 写计划字段、record/deviation 回写执行状态。 引擎 v' + VERSION + '。'
            : '「计划实施」三合一编排引擎的记账本（状态机）：拷问决策(grill)→编译计划(compile)→执行验收(execute)。先用 skill 工具加载 plan-workflow 获取完整流程与提问策略，再驱动本工具。触发：仅当用户说「计划实施」「拷问决策」「编译计划」「执行计划」「跑计划」时调用本工具；用户明确说「直接做/不用确认/跳过流程」时跳过本流程。多步驱动(action=start/answer/continue/report/stop)；说「结束」结束当前阶段，说「暂停」停留在本阶段；主 agent 用 question 喂题、section+content 写计划字段、record/deviation 回写执行状态。 引擎 v' + VERSION + '。'),
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
