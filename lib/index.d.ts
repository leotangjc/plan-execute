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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-plan-execute";
/** Services required before this plugin can register. */
export declare const inject: string[];
/** 插件配置；全部可选，缺省值在 apply 内合并。 */
export interface PlanExecuteConfig {
    /** 项目/计划标识缺省值（缺省 'plan'） */
    defaultSlug?: string;
    /** 拷问决策记录目录（缺省 '.grill'） */
    grillDir?: string;
    /** 执行计划与阶段指针目录（缺省 '.plan'） */
    planDir?: string;
    /** 默认触发模式：需求模糊/多步骤/项目级新任务默认进入流程（true），否则仅触发词触发（false）。缺省 true。 */
    autoTrigger?: boolean;
}
/** 结构性镜像：DSH tools 注册表。 */
export interface ToolsService {
    register(definition: PlanToolDefinition): () => void;
}
/** 结构性镜像：DSH skills 注册表（只取 register 契约）。 */
export interface SkillsService {
    register(skill: {
        name: string;
        description: string;
        whenToUse?: string;
        source: string;
        content: string;
    }): () => void;
}
/** 结构性镜像：DSH fs 服务。 */
export interface FsInfo {
    version?: unknown;
}
export interface FsTarget {
    targetKey: string;
    displayPath: string;
}
export interface FsService {
    resolve(path: string, opts?: {
        cwd?: string;
    }): Promise<FsTarget | undefined>;
    stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
    readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
    writeText(target: FsTarget, content: string, intent?: unknown, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<{
        version?: unknown;
    }>;
}
/** 结构性镜像：沙箱策略服务（per-session policy，含 workspaceRoot）。 */
export interface SandboxPolicyService {
    resolve(opts?: {
        session?: unknown;
    }): {
        mode?: string;
        workspaceRoot?: string;
    } | undefined;
}
/** 工具执行上下文的精简镜像。 */
export interface ExecCtx {
    signal?: AbortSignal;
    agent?: {
        session?: {
            header?: {
                cwd?: string;
            };
        };
    };
}
export type Phase = 'grill' | 'compile' | 'execute' | 'done';
export type NextAction = 'start' | 'answer' | 'continue' | 'report' | 'stop';
export interface StepResult {
    text: string;
    nextAction: NextAction;
    phase: Phase;
    slug: string;
}
export interface PlanToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        additionalProperties: boolean;
        properties: Record<string, Record<string, unknown>>;
        required: string[];
    };
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: StepResult): Array<{
            type: string;
            text: string;
        }>;
    };
    execute(args: Record<string, unknown>, exec: ExecCtx): Promise<StepResult>;
}
export declare function apply(ctx: Context, _config?: PlanExecuteConfig): void;
