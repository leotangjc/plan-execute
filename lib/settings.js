/**
 * dsh-plan-execute — 插件设置（rc.7 settings 服务接入）
 *
 * Host 侧注册 namespace schema（设置数据模型 + 解析）。
 * 注意：schema 注册只让 namespace 出现在「可配置插件」列表；设置卡片 UI 由
 * Client 半体注册到 settings.plugin.item slot（见 src/client.ts），schema 不是自动渲染的。
 *
 * 设置项：
 * - mode: light（缺省）/ heavy —— 工作模式（切模式需重启，涉及文件契约）
 * - autoTrigger: 需求模糊任务默认进入流程（可热切）
 * - auditLog: heavy 专属，审计日志开关（.plan/<slug>.log；可热切）
 *
 * 解析顺序（dsh-settings 服务）：schema 默认值 → 组合 config（base）→ 用户设置层。
 */
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import Schema from '@deepseek-ai/schemastery';
/** 设置 namespace（小写 kebab-case，与插件短名一致）。 */
export const SETTINGS_NAMESPACE = 'dsh-plan-execute';
/** 设置 schema：数据模型；Client 卡片据此渲染字段。 */
export const PlanExecuteSettingsSchema = Schema.object({
    mode: Schema.union(['light', 'heavy']).default('light').description('工作模式：light 简化 / heavy 完整防御'),
    autoTrigger: Schema.boolean().default(true).description('需求模糊/多步骤任务默认进入流程（false = 仅触发词进入）'),
    auditLog: Schema.boolean().default(true).description('heavy 模式审计日志（.plan/<slug>.log；light 模式无此文件）'),
});
/** 返回 namespace 品牌值（register 的第一参）。 */
export function ns() {
    return settingsNamespace(SETTINGS_NAMESPACE);
}
