/**
 * 显式状态机表：把「阶段 × 动作」的合法性矩阵与「推进事件」的目标阶段抽成数据表。
 * 作用：
 *  - 合法性一眼可见、可机器校验（table-driven 测试）；
 *  - runCore 查表，非法组合给明确提示（取代散落的「未知动作。」死路）；
 *  - NEXT_PHASE 集中定义阶段推进目标（grill→compile→execute→done）。
 *
 * 约定：规则值为 ''（或缺失）表示「放行到对应阶段处理器」；非空字符串为「拦截提示」。
 */

export type Phase = 'grill' | 'compile' | 'execute' | 'done'
export type Action = 'start' | 'answer' | 'continue' | 'report' | 'stop'

export const PHASES: readonly Phase[] = ['grill', 'compile', 'execute', 'done']

/** 推进事件的目标阶段（阶段内由「结束/够了/结束拷问」等推进词触发）。 */
export const NEXT_PHASE: Record<'grill' | 'compile' | 'execute', Phase> = {
  grill: 'compile',
  compile: 'execute',
  execute: 'done',
}

/** 阶段 × 动作 合法性矩阵。非空字符串 = 该组合被拦截的明确提示。 */
export const ACTION_RULES: Record<Phase, Partial<Record<Action, string>>> = {
  grill: {
    start: '',
    answer: '',
    report: '',
    stop: '',
    continue: '当前已在「拷问决策」阶段：继续请直接提问，或用 answer 记录上一题回答（说「结束」进入编译）。',
  },
  compile: {
    start: '',
    answer: '',
    continue: '',
    report: '',
    stop: '',
  },
  execute: {
    start: '',
    answer: '',
    continue: '',
    report: '',
    stop: '',
  },
  done: {
    start: '',
    report: '',
    answer: '流程已完成。如需重跑：换一个 slug 新建，或删除 .grill/.plan 文件后 action=start。',
    continue: '流程已完成。如需重跑：换一个 slug 新建，或删除 .grill/.plan 文件后 action=start。',
    stop: '流程已完成，无需停止。',
  },
}

/** 查表：返回拦截提示（空串/undefined = 放行）。 */
export function blockedMessage(phase: Phase, action: Action): string | undefined {
  const msg = ACTION_RULES[phase]?.[action]
  return msg ? msg : undefined
}
