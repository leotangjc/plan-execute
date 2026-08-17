/**
 * dsh-plan-execute — Client 半体（设置卡片）
 *
 * 注册 settings.plugin.item 卡片（key = dsh-plan-execute namespace），
 * 用 settingsScope.bind({namespace}) 读/写设置：
 * - mode: light/heavy 下拉
 * - autoTrigger: 开关
 * - auditLog: 开关（heavy 专属）
 *
 * 说明：
 * - 改动即时写回（settingsScope.set），引擎 config 在 apply 时固化 → 改动重启生效；
 *   卡片显式标注「重启后生效」。
 * - mode 切换涉及文件契约不同（light/heavy 计划互不可见），卡片提示。
 *
 * 本文件是纯 JS 函数体（无 TS/JSX），esbuild 打包成 lib/client.js。
 */

function apply(ctx) {
  // 诊断：记录 apply 执行路径（写到 window 供浏览器侧读取）
  const diag = { called: true, hasGet: typeof ctx.get === 'function', slotsViaGet: undefined, slotsViaProp: undefined, settingsScopeViaGet: undefined, settingsScopeViaProp: undefined, error: undefined }
  try {
    diag.slotsViaGet = typeof ctx.get === 'function' ? typeof ctx.get('slots') : 'no-get'
    diag.slotsViaProp = typeof ctx.slots
    diag.settingsScopeViaGet = typeof ctx.get === 'function' ? typeof ctx.get('settingsScope') : 'no-get'
    diag.settingsScopeViaProp = typeof ctx.settingsScope
  } catch (e) { diag.error = String(e) }
  if (typeof window !== 'undefined') window.__PLAN_DIAG__ = diag

  // 与 dsh-notification 一致：用 ctx.slots 属性（declared-service access）
  const slots = ctx.slots || (ctx.get && ctx.get('slots'))
  if (slots === undefined) { if (typeof window !== 'undefined') window.__PLAN_DIAG__ = { ...diag, fail: 'slots undefined' }; return }
  const settingsScope = ctx.settingsScope || (ctx.get && ctx.get('settingsScope'))
  if (settingsScope === undefined) { if (typeof window !== 'undefined') window.__PLAN_DIAG__ = { ...diag, fail: 'settingsScope undefined', slotsOk: true }; return }
  if (typeof window !== 'undefined') window.__PLAN_DIAG__ = { ...diag, proceed: true, slotsOk: true, settingsScopeOk: true }

  const NAMESPACE = 'dsh-plan-execute'
  const controller = settingsScope.bind({ namespace: NAMESPACE })

  slots.inject('settings.plugin.item', () => slots.register(
    {
      name: 'settings.plugin.item',
      key: NAMESPACE,
    },
    () => {
      const React = require('react')
      const { useState, useEffect } = React

      function PlanExecuteCard() {
        const [snapshot, setSnapshot] = useState(controller.getSnapshot())
        useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [])

        const value = snapshot.value || {}
        const writable = snapshot.writable !== false
        const loading = snapshot.status === 'loading' || snapshot.status === undefined

        // 每字段即时保存（简单可靠，不做 draft/save 状态机）
        const setField = (field, v) => {
          controller.set(field, v)
        }

        const row = (label, hint, control) => React.createElement(
          'div',
          { style: { margin: '8px 0' } },
          React.createElement('div', { style: { fontWeight: 600 } }, label),
          control,
          hint ? React.createElement('div', { style: { fontSize: 12, opacity: 0.7, marginTop: 2 } }, hint) : null,
        )

        const select = (field, options) => React.createElement(
          'select',
          {
            value: value[field] || options[0],
            disabled: !writable || loading,
            onChange: (e) => setField(field, e.target.value),
            style: { marginTop: 4, padding: '4px 8px' },
          },
          options.map((o) => React.createElement('option', { key: o, value: o }, o)),
        )

        const toggle = (field, labelOn, labelOff) => React.createElement(
          'label',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, cursor: writable ? 'pointer' : 'not-allowed' } },
          React.createElement('input', {
            type: 'checkbox',
            checked: value[field] !== false,
            disabled: !writable || loading,
            onChange: (e) => setField(field, e.target.checked),
          }),
          React.createElement('span', null, value[field] !== false ? labelOn : labelOff),
        )

        if (loading) {
          return React.createElement('div', { style: { padding: 12 } }, '加载设置中…')
        }

        return React.createElement(
          'div',
          { style: { padding: 12, maxWidth: 480 } },
          row('工作模式', '切换后重启生效；light/heavy 的计划文件互不可见', select('mode', ['light', 'heavy'])),
          row('默认进入流程', '需求模糊/多步骤任务是否默认进入流程（false = 仅触发词）；重启生效', toggle('autoTrigger', '开：默认进入', '关：仅触发词')),
          row('审计日志（heavy）', 'heavy 模式是否写 .plan/<slug>.log；light 模式无此文件；重启生效', toggle('auditLog', '开：记录日志', '关：不记录')),
        )
      }

      return React.createElement(PlanExecuteCard)
    },
  ))
}

module.exports = { apply }
