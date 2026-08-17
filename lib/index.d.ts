/**
 * dsh-plan-execute — 「计划实施」编排引擎（双模式入口）
 *
 * 一个包两套引擎，由组合行 config.mode 切换：
 * - light（缺省）：简化版，任务状态 = md 勾选行（- [x] T1: 标题），面向普通用户。
 *   文件契约：<slug>.md + .plan/<slug>.meta.json；动作 start/confirm/deviation/report/stop/continue。
 * - heavy：完整防御版，grill→compile→execute→done 全状态机 + 两层确认 + 六字段 +
 *   活动指针 + 审计日志 + 防御设计。
 *   文件契约：.grill/<slug>.md + .plan/<slug>.md + .plan/<slug>.meta.json + .current + .log；
 *   动作 start/answer/continue/report/stop。
 *
 * 工具名与 skill 名两模式共用（plan_execute / plan-workflow），行为由 mode 决定。
 * 切换：agent-preset 组合行 config.mode: light|heavy（已实证 preset 组合行支持 config）。
 *
 * @module dsh-plan-execute
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PlanExecuteConfig } from './types.js';
export declare const name = "dsh-plan-execute";
export declare const inject: string[];
export type { ExecCtx, FsEditRequest, FsInfo, FsService, FsTarget, FsWriteExpected, NextAction, Phase, PlanExecuteConfig, PlanToolDefinition, SandboxPolicyService, SkillsService, StepResult, ToolsService, } from './types.js';
export { buildSkillContent } from './skill-content.js';
export { VERSION } from './version.js';
/** 入口：按 config.mode 分发到 light / heavy 引擎。 */
export declare function apply(ctx: Context, _config?: PlanExecuteConfig): void;
