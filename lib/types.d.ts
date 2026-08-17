/**
 * dsh-plan-execute — 公共类型镜像（light/heavy 双引擎共用超集）
 * 结构性镜像 DSH 真实服务；类型为并集：两引擎各自只用到所需子集。
 */
/** 插件配置；mode 决定启用哪套引擎（light=简化 / heavy=完整防御）。 */
export interface PlanExecuteConfig {
    /** 工作模式：light（md 勾选即状态，面向普通用户）/ heavy（完整状态机+审计，面向重度）。缺省 light。 */
    mode?: 'light' | 'heavy';
    /** 项目/计划标识缺省值（缺省 'plan'） */
    defaultSlug?: string;
    /** 拷问决策记录目录（heavy 用；缺省 '.grill'） */
    grillDir?: string;
    /** 执行计划与阶段指针目录（缺省 '.plan'） */
    planDir?: string;
    /** 默认触发模式：需求模糊/多步骤/项目级新任务默认进入流程（true），否则仅触发词触发（false）。缺省 true。 */
    autoTrigger?: boolean;
    /** 审计日志开关（heavy 模式 .plan/<slug>.log；light 模式无此文件）。缺省 true。 */
    auditLog?: boolean;
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
/** 结构性镜像：DSH fs 服务（真实签名超集：light 用 editText，heavy 用 writeText+expected）。 */
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
    editText?(target: FsTarget, edit: FsEditRequest, expected?: {
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
export type Phase = 'grill' | 'compile' | 'execute' | 'done';
/** light 动作并集（heavy 不含 confirm/deviation 单列——其 deviation 走 answer 参数；此处为超集）。 */
export type NextAction = 'start' | 'answer' | 'continue' | 'report' | 'stop' | 'confirm' | 'deviation';
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
