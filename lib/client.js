window.__ModuleLoader__.load({
  id: "dsh-plan-execute",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

"use strict";

// src/client.ts
function apply(ctx) {
  const getService = (name) => ctx && typeof ctx.get === "function" ? ctx.get(name) : void 0;
  const diag = { called: true, hasGet: typeof ctx.get === "function", slotsViaGet: typeof getService("slots"), settingsScopeViaGet: typeof getService("settingsScope"), error: void 0 };
  if (typeof window !== "undefined") window.__PLAN_DIAG__ = diag;
  const slots = getService("slots");
  if (slots === void 0) {
    if (typeof window !== "undefined") window.__PLAN_DIAG__ = { ...diag, fail: "slots undefined" };
    return;
  }
  const settingsScope = getService("settingsScope");
  if (settingsScope === void 0) {
    if (typeof window !== "undefined") window.__PLAN_DIAG__ = { ...diag, fail: "settingsScope undefined", slotsOk: true };
    return;
  }
  if (typeof window !== "undefined") window.__PLAN_DIAG__ = { ...diag, proceed: true, slotsOk: true, settingsScopeOk: true };
  const NAMESPACE = "dsh-plan-execute";
  const controller = settingsScope.bind({ namespace: NAMESPACE });
  slots.inject("settings.plugin.item", () => slots.register(
    {
      name: "settings.plugin.item",
      key: NAMESPACE
    },
    () => {
      const React = require("react");
      const { useState, useEffect } = React;
      function PlanExecuteCard() {
        const [snapshot, setSnapshot] = useState(controller.getSnapshot());
        useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), []);
        const value = snapshot.value || {};
        const writable = snapshot.writable !== false;
        const loading = snapshot.status === "loading" || snapshot.status === void 0;
        const setField = (field, v) => {
          controller.set(field, v);
        };
        const row = (label, hint, control) => React.createElement(
          "div",
          { style: { margin: "8px 0" } },
          React.createElement("div", { style: { fontWeight: 600 } }, label),
          control,
          hint ? React.createElement("div", { style: { fontSize: 12, opacity: 0.7, marginTop: 2 } }, hint) : null
        );
        const select = (field, options) => React.createElement(
          "select",
          {
            value: value[field] || options[0],
            disabled: !writable || loading,
            onChange: (e) => setField(field, e.target.value),
            style: { marginTop: 4, padding: "4px 8px" }
          },
          options.map((o) => React.createElement("option", { key: o, value: o }, o))
        );
        const toggle = (field, labelOn, labelOff) => React.createElement(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 4, cursor: writable ? "pointer" : "not-allowed" } },
          React.createElement("input", {
            type: "checkbox",
            checked: value[field] !== false,
            disabled: !writable || loading,
            onChange: (e) => setField(field, e.target.checked)
          }),
          React.createElement("span", null, value[field] !== false ? labelOn : labelOff)
        );
        const title = React.createElement("div", { style: { fontWeight: 600, fontSize: 14, marginBottom: 8 } }, "\u8BA1\u5212\u5B9E\u65BD");
        if (loading) {
          return React.createElement("div", { style: { padding: 12 } }, title, "\u52A0\u8F7D\u8BBE\u7F6E\u4E2D\u2026");
        }
        return React.createElement(
          "div",
          { style: { padding: 12, maxWidth: 480 } },
          title,
          row("\u5DE5\u4F5C\u6A21\u5F0F", "\u5207\u6362\u540E\u91CD\u542F\u751F\u6548\uFF1Blight/heavy \u7684\u8BA1\u5212\u6587\u4EF6\u4E92\u4E0D\u53EF\u89C1", select("mode", ["light", "heavy"])),
          row("\u9ED8\u8BA4\u8FDB\u5165\u6D41\u7A0B", "\u9700\u6C42\u6A21\u7CCA/\u591A\u6B65\u9AA4\u4EFB\u52A1\u662F\u5426\u9ED8\u8BA4\u8FDB\u5165\u6D41\u7A0B\uFF08false = \u4EC5\u89E6\u53D1\u8BCD\uFF09\uFF1B\u91CD\u542F\u751F\u6548", toggle("autoTrigger", "\u5F00\uFF1A\u9ED8\u8BA4\u8FDB\u5165", "\u5173\uFF1A\u4EC5\u89E6\u53D1\u8BCD")),
          row("\u5BA1\u8BA1\u65E5\u5FD7\uFF08heavy\uFF09", "heavy \u6A21\u5F0F\u662F\u5426\u5199 .plan/<slug>.log\uFF1Blight \u6A21\u5F0F\u65E0\u6B64\u6587\u4EF6\uFF1B\u91CD\u542F\u751F\u6548", toggle("auditLog", "\u5F00\uFF1A\u8BB0\u5F55\u65E5\u5FD7", "\u5173\uFF1A\u4E0D\u8BB0\u5F55"))
        );
      }
      return React.createElement(PlanExecuteCard);
    }
  ));
}
module.exports = { apply };
    return module.exports;
  }
});

//# sourceMappingURL=client.js.map
