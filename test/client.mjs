// Smoke test for the dsh-auto-create-folder CLIENT bundle.
// Evaluates lib/client.js against a stub window.__ModuleLoader__ and renders the settings row.
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra === undefined ? "" : " :: " + extra)); }
}

// ---- stub module loader --------------------------------------------------
let def = null;
const fakeWindow = { __ModuleLoader__: { load: (d) => { def = d; } } };
const code = readFileSync(join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
try { new Function("window", code)(fakeWindow); } catch (e) { check("bundle evaluates", false, e.message); }
check("bundle evaluates", !!def, "no load() call");
check("bundle id", def && def.id === "dsh-auto-create-folder", def && def.id);
check("bundle factory", !!def && typeof def.factory === "function");

// ---- stub requires -------------------------------------------------------
const Switch = function Switch() {};
const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) };
const requireStub = (name) => {
  if (name === "react") return react;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return { Switch };
  throw new Error("unexpected require: " + name);
};

let mod = null;
try { mod = def.factory(requireStub); } catch (e) { check("factory runs", false, e.message); }
check("factory runs", !!mod);
check("exports.apply", !!mod && typeof mod.apply === "function");
check("exports.inject", !!mod && Array.isArray(mod.inject));
check("inject declares slots/locale/configForms",
  !!mod && ["slots", "locale", "configForms"].every((name) => mod.inject.includes(name)),
  mod && JSON.stringify(mod.inject));

// ---- stub client context -------------------------------------------------
const locales = [], effects = [], injected = [], registered = [], writes = [];
let formValue = { enabled: true };
let formSubscriptions = 0;
const form = {
  getSnapshot: () => ({ status: "ready", value: formValue, mode: "host" }),
  subscribe: (listener) => { formSubscriptions++; return () => {}; },
  set: (field, value) => { writes.push([field, value]); return Promise.resolve(true); }
};
const ctx = {
  effect: (fn, label) => { const disposer = fn(); effects.push({ fn, label, disposer }); return () => {}; },
  locale: { register: (ns, dict) => { locales.push({ ns, dict }); return () => {}; } },
  slots: {
    inject: (slot, cb) => { injected.push(slot); cb(); return () => {}; },
    register: (options, component) => { registered.push({ options, component }); return () => {}; }
  },
  configForms: { get: (entryId) => { form.entryId = entryId; return form; } }
};

let applyError = null;
try { mod.apply(ctx); } catch (e) { applyError = e; }
check("apply runs", applyError === null, applyError && applyError.message);
check("locale registered once", locales.length === 1, JSON.stringify(locales.map((l) => l.ns)));
check("locale ns", locales[0] && locales[0].ns === "auto-folder", locales[0] && locales[0].ns);
check("locale zh/en", !!locales[0] && !!locales[0].dict.zh && !!locales[0].dict.en);
check("locale copy", !!locales[0] && typeof locales[0].dict.zh.title === "string" && typeof locales[0].dict.en.title === "string");
check("locale effect labelled", effects.length === 1 && typeof effects[0].label === "string", JSON.stringify(effects.map((e) => e.label)));
check("registered general item", registered.length === 1, registered.length);
const reg = registered[0] || { options: { inject: () => ({ hooks: {}, setEnabled: () => {} }) }, component: () => ({ type: "none", props: {}, children: [] }) };
check("slot name", !!reg && reg.options.name === "settings.general.item", reg && reg.options.name);
check("row id", !!reg && reg.options.id === "auto-folder", reg && reg.options.id);
check("row order numeric", !!reg && typeof reg.options.order === "number", reg && reg.options.order);
check("row locale", !!reg && reg.options.locale === "auto-folder", reg && reg.options.locale);
check("injected into general slot", injected[0] === "settings.general.item", injected[0]);
check("component is function", !!reg && typeof reg.component === "function");

// ---- injected props ------------------------------------------------------
const props = (reg.options.inject && reg.options.inject()) || { hooks: {}, setEnabled: () => {} };
check("inject hooks.enabled", !!(props && props.hooks && props.hooks.enabled), JSON.stringify(Object.keys(props || {})));
check("inject setEnabled", typeof props.setEnabled === "function");
check("hook getSnapshot reads form", props.hooks.enabled.getSnapshot() === true, String(props.hooks.enabled.getSnapshot()));
props.hooks.enabled.subscribe(() => {});
check("hook subscribe delegates", formSubscriptions === 1, formSubscriptions);

// ---- render --------------------------------------------------------------
if (locales.length === 0) {
  console.log("DIAG def=" + !!def + " mod=" + !!mod + " applyError=" + (applyError && applyError.message) + " injected=" + JSON.stringify(injected) + " registered=" + registered.length);
}
const dict = (locales[0] && locales[0].dict.zh) || { title: "?", description: "?" };
const t = (key) => dict[key];
const useEnabled = (selector) => selector(props.hooks.enabled.getSnapshot());
const tree = reg.component({ useEnabled, setEnabled: props.setEnabled, t });
function find(node, type) {
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child, type); if (hit) return hit; } return null; }
  if (!node || typeof node !== "object") return null;
  if (node.type === type) return node;
  return find(node.children, type);
}
const sw = find(tree, Switch);
check("renders a Switch", !!sw);
check("switch checked mirrors the form", !!sw && sw.props.checked === true, sw && String(sw.props.checked));
check("switch labelled", !!sw && sw.props.label === dict.title, sw && sw.props.label);
check("switch onChange wired", !!sw && typeof sw.props.onChange === "function");
const text = JSON.stringify(tree);
check("row shows the title", text.includes(dict.title));
check("row shows the description", text.includes(dict.description));

// ---- interaction ---------------------------------------------------------
sw.props.onChange(false);
check("onChange writes enabled=false", JSON.stringify(writes) === JSON.stringify([["enabled", false]]), JSON.stringify(writes));
formValue = { enabled: false };
const tree2 = reg.component({ useEnabled, setEnabled: props.setEnabled, t });
check("switch follows the form value", find(tree2, Switch).props.checked === false);

// ---- fallbacks -----------------------------------------------------------
formValue = {};
const tree3 = reg.component({ useEnabled, setEnabled: props.setEnabled, t });
check("missing value defaults on", find(tree3, Switch).props.checked === true);
check("form looked up by entry id", form.entryId === "auto-folder", form.entryId);

console.log("PASS " + pass + "  FAIL " + fail);
if (failures.length) { console.log("FAILURES:"); for (const f of failures) console.log(" - " + f); }
process.exit(fail ? 1 : 0);
