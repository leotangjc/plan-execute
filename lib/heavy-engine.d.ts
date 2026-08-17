/**
 * dsh-plan-execute — heavy 引擎（完整防御版 / main 设计）
 * 完整状态机（grill→compile→execute→done）+ 两层确认 + 六字段 + 活动指针 + 审计日志 + 防御设计。
 * 与 light 引擎并存，由顶层 index.ts 按 config.mode 分发。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PlanExecuteConfig } from './types.js';
export declare function applyHeavy(ctx: Context, _config?: PlanExecuteConfig): void;
