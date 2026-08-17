/**
 * dsh-plan-execute — light 引擎（简化版 / arch-final 设计）
 * 任务状态 = md 勾选行（- [x] T1: 标题）；引擎只读 md、只写 meta，绝不覆盖。
 * 设计核心见 ARCHITECTURE.md §2-§5（heavy-reasoning 收敛 + 实证）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PlanExecuteConfig } from './types.js';
export declare function applyLight(ctx: Context, _config?: PlanExecuteConfig): void;
