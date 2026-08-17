/**
 * 显式状态机表：把「阶段 × 动作」的合法性矩阵与「推进事件」的目标阶段抽成数据表。
 * 作用：
 *  - 合法性一眼可见、可机器校验（table-driven 测试）；
 *  - runCore 查表，非法组合给明确提示（取代散落的「未知动作。」死路）；
 *  - NEXT_PHASE 集中定义阶段推进目标（grill→compile→execute→done）。
 *
 * 约定：规则值为 ''（或缺失）表示「放行到对应阶段处理器」；非空字符串为「拦截提示」。
 */
export type Phase = 'grill' | 'compile' | 'execute' | 'done';
export type Action = 'start' | 'answer' | 'continue' | 'report' | 'stop';
export declare const PHASES: readonly Phase[];
/** 推进事件的目标阶段（阶段内由「结束/够了/结束拷问」等推进词触发）。 */
export declare const NEXT_PHASE: Record<'grill' | 'compile' | 'execute', Phase>;
/** 阶段 × 动作 合法性矩阵。非空字符串 = 该组合被拦截的明确提示。 */
export declare const ACTION_RULES: Record<Phase, Partial<Record<Action, string>>>;
/** 查表：返回拦截提示（空串/undefined = 放行）。 */
export declare function blockedMessage(phase: Phase, action: Action): string | undefined;
