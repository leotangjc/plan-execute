/**
 * dsh-plan-execute — 插件设置（rc.7 settings 服务接入）
 *
 * 注册 namespace schema，DSH 设置界面自动生成设置卡片（schema 驱动，零前端代码）：
 * - mode: light（缺省）/ heavy —— 工作模式
 * - autoTrigger: 需求模糊任务默认进入流程
 * - defaultSlug: 缺省项目名
 *
 * 解析顺序（dsh-settings 服务）：schema 默认值 → 组合 config（base）→ 用户设置层。
 * 引擎通过 scope.get() 读解析后的值；组合 config 作为 base 兜底。
 */

import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'

/** 设置 namespace（小写 kebab-case，与插件短名一致）。 */
export const SETTINGS_NAMESPACE = 'dsh-plan-execute'

/** 设置 schema：UI 依据它渲染表单。 */
export const PlanExecuteSettingsSchema = Schema.object({
  mode: Schema.union(['light', 'heavy']).default('light').description('工作模式：light 简化 / heavy 完整防御'),
  autoTrigger: Schema.boolean().default(true).description('需求模糊/多步骤任务默认进入流程（false = 仅触发词进入）'),
  defaultSlug: Schema.string().default('plan').description('项目/计划标识缺省值'),
})

/** 设置解析后的值形状。 */
export interface PlanExecuteSettings {
  mode: 'light' | 'heavy'
  autoTrigger: boolean
  defaultSlug: string
}

/** 返回 namespace 品牌值（register 的第一参）。 */
export function ns(): unknown {
  return settingsNamespace(SETTINGS_NAMESPACE)
}
