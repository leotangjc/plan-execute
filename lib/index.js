/**
 * dsh-plan-execute — 「计划实施」编排引擎（双模式入口 + 设置界面）
 *
 * 一个包两套引擎，由设置/配置的 mode 切换：
 * - light（缺省）：简化版，任务状态 = md 勾选行（- [x] T1: 标题），面向普通用户。
 *   文件契约：<slug>.md + .plan/<slug>.meta.json；动作 start/confirm/deviation/report/stop/continue。
 * - heavy：完整防御版，grill→compile→execute→done 全状态机 + 两层确认 + 六字段 +
 *   活动指针 + 审计日志 + 防御设计。
 *   文件契约：.grill/<slug>.md + .plan/<slug>.md + .plan/<slug>.meta.json + .current + .log；
 *   动作 start/answer/continue/report/stop。
 *
 * 设置（DSH rc.7 settings 服务）：注册 schema → 设置界面自动生成卡片。
 * 解析顺序：schema 默认值 → 组合 config（base）→ 用户设置层；引擎读 scope.get()。
 * mode 在 inject(['settings']) 回调内解析（服务就绪保证，dsh-agent-presets 同款模式）。
 *
 * @module dsh-plan-execute
 */
import { applyHeavy } from './heavy-engine.js';
import { applyLight } from './light-engine.js';
import { ns, PlanExecuteSettingsSchema } from './settings.js';
export const name = 'dsh-plan-execute';
export const inject = ['tools'];
export { buildSkillContent } from './skill-content.js';
export { VERSION } from './version.js';
/** 入口：注册设置（若可用），按解析后的 mode 分发引擎。 */
export function apply(ctx, _config = {}) {
    if (ctx.get('settings') === undefined) {
        // settings 服务不可用（旧版 DSH）：回退组合 config，同步分发
        dispatch(ctx, _config, _config.mode === 'heavy' ? 'heavy' : 'light');
        return;
    }
    // settings 可用：注册 schema 并在回调内读解析值分发（服务就绪保证）
    ctx.inject(['settings'], (sctx) => {
        const settingsService = sctx.settings;
        const scope = settingsService.register(ns(), PlanExecuteSettingsSchema, {
            base: { default: { mode: _config.mode, autoTrigger: _config.autoTrigger, defaultSlug: _config.defaultSlug } },
        });
        const resolved = scope.get();
        const mode = resolved?.mode === 'heavy' ? 'heavy' : 'light';
        dispatch(ctx, { ..._config, mode: resolved?.mode, autoTrigger: resolved?.autoTrigger, defaultSlug: resolved?.defaultSlug }, mode);
    });
}
/** 按 mode 分发到对应引擎。 */
function dispatch(ctx, config, mode) {
    if (mode === 'heavy') {
        applyHeavy(ctx, { ...config, mode: 'heavy' });
    }
    else {
        applyLight(ctx, { ...config, mode: 'light' });
    }
}
