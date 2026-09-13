window.__ModuleLoader__.load({ id: "dsh-subagent-preset-in-process", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
"use strict";
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var React = __toESM(require("react"), 1);
var SETTINGS_NS = "subagent-preset-in-process";
var TEXT_FIELDS = ["providerName", "presetId", "maxTokens", "maxDepth"];
var LABELS = {
  providerName: "Provider name",
  presetId: "Preset id",
  maxTokens: "Max tokens",
  maxDepth: "Max depth"
};
var MODEL_SEP = "\0";
var labelStyle = { display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, color: "var(--dsw-alias-label-secondary, #555)" };
var inputStyle = { width: "100%", boxSizing: "border-box", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #ccc)", background: "var(--dsw-alias-bg-layer-3, #fff)", color: "var(--dsw-alias-label-primary, #111)" };
var saveStyle = { padding: "8px 16px", borderRadius: 6, border: "none", background: "var(--dsw-alias-label-primary, #111)", color: "var(--dsw-alias-bg-layer-3, #fff)", cursor: "pointer" };
function Card({ scope, api }) {
  const [snap, setSnap] = React.useState(() => scope.getSnapshot());
  React.useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  const [draft, setDraft] = React.useState(() => {
    const v = scope.getSnapshot().value ?? {};
    const out = {};
    for (const k of TEXT_FIELDS) {
      const val = v[k];
      out[k] = val === void 0 || val === null ? "" : String(val);
    }
    out.crews = JSON.stringify(v.crews ?? {}, null, 2);
    return out;
  });
  const [modelSel, setModelSel] = React.useState(() => {
    const v = scope.getSnapshot().value ?? {};
    const provider = v.provider;
    const model = v.model;
    if (typeof provider === "string" && typeof model === "string" && provider !== "" && model !== "") {
      return provider + MODEL_SEP + model;
    }
    return "";
  });
  const [groups, setGroups] = React.useState([]);
  const [catalogStatus, setCatalogStatus] = React.useState("loading");
  const [catalogError, setCatalogError] = React.useState("");
  React.useEffect(() => {
    if (api === void 0) {
      setCatalogStatus("error");
      setCatalogError("Model catalog unavailable: no connection to the host.");
      return;
    }
    let cancelled = false;
    setCatalogStatus("loading");
    setCatalogError("");
    (async () => {
      try {
        const resp = await api.llm.models({});
        if (cancelled) return;
        if (!resp.result.ok) {
          setCatalogStatus("error");
          setCatalogError(`${resp.result.error.code}: ${resp.result.error.message}`);
          return;
        }
        setGroups(resp.result.value.groups);
        setCatalogStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setCatalogStatus("error");
        setCatalogError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  if (snap.status === "unavailable") {
    return React.createElement("p", null, "Settings unavailable for this plugin.");
  }
  if (!snap.writable) {
    return React.createElement("p", null, "Settings are read-only in this deployment.");
  }
  const textField = (field) => React.createElement(
    "div",
    { key: field, style: { marginBottom: 12 } },
    React.createElement("label", { style: labelStyle }, LABELS[field] ?? field),
    React.createElement("input", {
      value: draft[field] ?? "",
      onChange: (e) => setDraft((d) => ({ ...d, [field]: e.target.value })),
      style: inputStyle
    })
  );
  const known = groups.flatMap((g) => g.models.map((m) => g.id + MODEL_SEP + m.id));
  const selectionKnown = modelSel === "" || known.includes(modelSel);
  const labelFor = (key) => {
    const idx = key.indexOf(MODEL_SEP);
    if (idx < 0) return key;
    return `${key.slice(0, idx)} / ${key.slice(idx + 1)}`;
  };
  const modelField = React.createElement(
    "div",
    { style: { marginBottom: 12 } },
    React.createElement("label", { style: labelStyle }, "Model"),
    catalogStatus === "loading" ? React.createElement("p", { style: { margin: "0 0 4px", color: "var(--dsw-alias-label-tertiary, #888)" } }, "Loading model catalog\u2026") : catalogStatus === "error" ? React.createElement("p", { style: { margin: "0 0 4px", color: "#d92d20" } }, catalogError) : null,
    React.createElement(
      "select",
      {
        value: modelSel,
        onChange: (e) => setModelSel(e.target.value),
        style: inputStyle
      },
      React.createElement("option", { value: "" }, "Use composition default"),
      !selectionKnown ? React.createElement("option", { value: modelSel }, `${labelFor(modelSel)} (current)`) : null,
      groups.map(
        (group) => React.createElement(
          "optgroup",
          { key: group.id, label: group.name },
          group.models.map(
            (model) => React.createElement("option", {
              key: group.id + MODEL_SEP + model.id,
              value: group.id + MODEL_SEP + model.id
            }, model.description ? `${model.name} \u2014 ${model.description}` : model.name)
          )
        )
      )
    )
  );
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      for (const field of ["providerName", "presetId"]) {
        const v = draft[field] ?? "";
        if (v === "") await scope.unset(field);
        else await scope.set(field, v);
      }
      const sep = modelSel.indexOf(MODEL_SEP);
      if (modelSel === "" || sep < 0) {
        await scope.unset("provider");
        await scope.unset("model");
      } else {
        await scope.set("provider", modelSel.slice(0, sep));
        await scope.set("model", modelSel.slice(sep + 1));
      }
      const maxTokens = draft.maxTokens;
      if (maxTokens === void 0 || maxTokens === "") await scope.unset("maxTokens");
      else await scope.set("maxTokens", Number(maxTokens));
      const maxDepth = draft.maxDepth;
      if (maxDepth === void 0 || maxDepth === "") await scope.unset("maxDepth");
      else if (maxDepth === "provider-managed") await scope.set("maxDepth", "provider-managed");
      else await scope.set("maxDepth", Number(maxDepth));
      const crews = draft.crews ?? "{}";
      if (crews.trim() === "" || crews.trim() === "{}") await scope.unset("crews");
      else await scope.set("crews", JSON.parse(crews));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return React.createElement(
    "div",
    { style: { padding: "4px 0" } },
    ...TEXT_FIELDS.map(textField),
    modelField,
    React.createElement(
      "div",
      { style: { marginBottom: 8 } },
      React.createElement("label", { style: labelStyle }, "Crews (JSON)"),
      React.createElement(
        "p",
        { style: { margin: "0 0 6px", fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)", lineHeight: 1.4 } },
        `Routed (model chooses next role) or pipeline (ordered chain with verify-gate). Each role carries roleTask + tasks [{id,title,acceptanceCriteria,status}], and may pin its own route with agentOptions {provider,model,maxTokens} (wins over the settings above, field by field; legacy flat provider/model/maxTokens still work as aliases). Example: {"engineering":{"mode":"pipeline","roles":[{"name":"planner","presetId":"subagent-slim","roleTask":"Plan","tasks":[{"id":"T1","title":"Implement X","acceptanceCriteria":"Tests pass","status":"pending"}]},{"name":"verifier","presetId":"subagent-slim","roleTask":"Verify T1","agentOptions":{"model":"gpt-5.6-sol"}}],"pipeline":{"order":["planner","builder","verifier"],"verifyGate":{"verifierRole":"verifier","maxRetries":3}}}} \u2014 use crew_status to read each role's effective route, and crew_pipeline_status / crew_verify / crew_task_update at runtime.`
      ),
      React.createElement("textarea", {
        value: draft.crews ?? "",
        rows: 12,
        onChange: (e) => setDraft((d) => ({ ...d, crews: e.target.value })),
        style: { ...inputStyle, height: 180, fontFamily: "monospace", whiteSpace: "pre", fontSize: 11 }
      })
    ),
    error ? React.createElement("p", { style: { color: "#d92d20" } }, error) : null,
    React.createElement(
      "button",
      { onClick: save, disabled: saving, style: saveStyle },
      saving ? "Saving\u2026" : "Save"
    )
  );
}
var name = "subagent-preset-in-process-client";
var inject = ["slots", "settingsScope", "connection", "remote"];
function apply(ctx) {
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
  const api = ctx.connection?.api;
  ctx.slots.inject(
    "settings.plugin.item",
    () => ctx.slots.register(
      { name: "settings.plugin.item", key: SETTINGS_NS, inject: () => ({ scope, api }) },
      (props) => React.createElement(Card, { scope: props.scope, api: props.api })
    )
  );
}
  return module.exports;
}});
