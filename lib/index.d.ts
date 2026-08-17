/**
 * dsh-plan-execute — 「计划实施」编排引擎（arch-final / 面向普通用户版）
 *
 * 一个包两个实体：
 * - 工具 `plan_execute`：闸门 + 统计 + 防覆盖（本文件）
 * - skill `plan-workflow`：编排大脑（apply 内注册，正文见 src/skill-content.ts）
 *
 * 设计核心（heavy-reasoning 收敛 + 两遍核验）：
 * - 状态真相 = md 勾选行：`- [x] T1: 标题`（skill 写，用户只看不改，引擎只读）。
 *   → 结构性免疫「skill 忘 record」：忘勾 = 用户看得见 + 收尾闸门阻塞，绝不静默缺失。
 * - 引擎职责 = 闸门与守卫：start 防覆盖（md/meta 任一存在即拒 + createIfAbsent 原子兜底）、
 *   confirm 推进（校验有任务行）、report 现算统计（永远与用户看见的 md 一致）、
 *   stop 收尾闸门、deviation 记偏差（引擎唯一写者 + 版本守卫）。
 * - failed/blocked 用 deviation 带类型前缀表达（md 保持标准两态，普通用户语义）。
 * - 引擎写 meta 一律 writeText + replaceIfVersion 版本守卫（跨进程安全，已实证）。
 *
 * @module dsh-plan-execute
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-plan-execute";
export declare const inject: string[];
/** 插件配置；全部可选，缺省值在 apply 内合并。 */
export interface PlanExecuteConfig {
    /** 项目/计划标识缺省值（缺省 'plan'） */
    defaultSlug?: string;
    /** 执行计划目录（缺省 '.plan'，存放 <slug>.meta.json） */
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
/** 结构性镜像：DSH fs 服务（真实签名，已实证：writeText 第3参 expected、editText 原子读改写）。 */
export interface FsTarget {
    targetKey: string;
    displayPath: string;
}
export interface FsInfo {
    version?: unknown;
    type?: string;
    size?: number;
}
export type FsWriteExpected = {
    kind: 'createIfAbsent';
} | {
    kind: 'replaceIfVersion';
    version: unknown;
};
export interface FsEditRequest {
    oldString: string;
    newString: string;
    replaceAll?: boolean;
}
export interface FsService {
    resolve(path: string, opts?: {
        cwd?: string;
    }): Promise<FsTarget | undefined>;
    stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
    readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
    writeText(target: FsTarget, content: string, expected?: FsWriteExpected, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<{
        version?: unknown;
    }>;
    editText(target: FsTarget, edit: FsEditRequest, expected?: {
        version: unknown;
    }, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<{
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
export type Phase = 'compile' | 'execute' | 'done';
export type NextAction = 'start' | 'confirm' | 'report' | 'deviation' | 'stop' | 'continue';
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
