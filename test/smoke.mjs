// Test suite for the dsh-auto-create-folder server plugin (lib/auto-folder.js).
// Stubs a Cordis ctx, a Session, and the fs service, then drives the write path.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Config, apply } from "../lib/auto-folder.js";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra === undefined ? "" : " :: " + extra)); }
}

const WORK = join(tmpdir(), "auto-folder-suite-" + Date.now());
mkdirSync(WORK, { recursive: true });
const OUTSIDE = join(tmpdir(), "auto-folder-outside-" + Date.now() + ".txt");
let wsIndex = 0;
function newWorkspace() { const dir = join(WORK, "ws" + wsIndex++); mkdirSync(dir, { recursive: true }); return dir; }

// ---- stubs ---------------------------------------------------------------
function makeSession(cwd, events, id) {
  return { id: id, header: { cwd: cwd }, snapshotEvents: () => events };
}
function titleEvent(title) { return { type: "session/title", data: { title: title } }; }
function userEvent(text) { return { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: text }] } }; }

function makeFs() {
  return {
    async resolve(p, options) {
      const root = options && options.cwd ? options.cwd : process.cwd();
      const abs = isAbsolute(p) ? p : join(root, p);
      return { displayPath: abs, targetKey: abs };
    },
    async writeText(target, content) {
      const existed = existsSync(target.targetKey);
      mkdirSync(dirname(target.targetKey), { recursive: true });
      writeFileSync(target.targetKey, String(content));
      return { operation: existed ? "update" : "create", version: 1 };
    },
    async editText(target) { return { operation: "update" }; }
  };
}

function setup(configValue) {
  const listeners = [];
  const injects = [];
  const injected = new Map();
  const effects = [];
  const configures = [];
  let fsContext = null;
  const ctx = {
    fiber: { id: "fiber" },
    effect(fn, label) { const disposer = fn(); effects.push({ label: label, disposer: disposer }); return () => {}; },
    on(name, fn) { if (name === "tools/execute") listeners.push(fn); return () => {}; },
    get(name) { return name === "fs" ? (fsContext ? fsContext.fs : undefined) : undefined; },
    inject(names, cb) {
      injects.push(names.join(","));
      if (names.includes("settings")) cb({ effect: (fn) => { fn(); return () => {}; }, settings: { configure: (opts) => { configures.push(opts); return () => {}; } } });
      if (names.includes("fs")) { fsContext = { fs: cbFs }; injected.set("fs", cb); cb(fsContext); }
      return () => {};
    }
  };
  const cbFs = makeFs();
  apply(ctx, configValue === undefined ? { enabled: { get: () => true } } : configValue);
  return { ctx: ctx, listeners: listeners, injects: injects, injected: injected, effects: effects, configures: configures, fs: () => cbFs, replaceFs() { const next = makeFs(); fsContext = { fs: next }; injected.get("fs")(fsContext); return next; } };
}

// Drive one tool call through the recorded tools/execute listeners, then the fs service.
async function toolWrite(env, session, path, content, name) {
  const exec = { name: name === undefined ? "write" : name, arguments: { file_path: path, content: content }, agent: { session: session } };
  let i = 0;
  const next = async () => { const fn = env.listeners[i++]; if (!fn) return undefined; return await fn(exec, next); };
  await next();
  const service = env.fs();
  const target = await service.resolve(path, { cwd: session.header.cwd });
  await service.writeText(target, content, undefined, undefined, undefined);
  return target;
}

// ---- 1. exports and config ----------------------------------------------
check("exports.Config", !!Config);
check("exports.apply", typeof apply === "function");
const enabledField = Config.dict && Config.dict.enabled;
check("enabled is a schema field", !!enabledField);
check("enabled default true", !!enabledField && !!enabledField.meta && enabledField.meta.default === true, JSON.stringify(enabledField && enabledField.meta));
check("enabled is volatile (settings row)", !!enabledField && !!enabledField.meta && enabledField.meta.volatile === true);
const resolved = Config["~standard"].validate({});
const enabledRef = resolved.value && resolved.value.enabled;
check("resolved enabled is a live ref", !!enabledRef && typeof enabledRef.get === "function", JSON.stringify(enabledRef));
check("resolved ref defaults to true", !!enabledRef && enabledRef.get() === true);
const offResolved = Config["~standard"].validate({ enabled: false });
check("user false is preserved", !!offResolved.value && offResolved.value.enabled.get() === false);

// ---- 2. registration ----------------------------------------------------
const env = setup();
check("subscribes to tools/execute", env.listeners.length === 1, env.listeners.length);
check("injects settings and fs", env.injects.join("|") === "settings|fs", env.injects.join("|"));
check("suppresses the auto settings page", env.configures.length === 1 && env.configures[0].auto === false, JSON.stringify(env.configures));

// ---- 3. a new file moves into a folder named after the task -------------
const ws1 = newWorkspace();
const s1 = makeSession(ws1, [userEvent("请构建登录页面"), titleEvent("构建登录页面")], "s1");
const t1 = await toolWrite(env, s1, join(ws1, "login.tsx"), "x");
const folder1 = join(ws1, "构建登录页面");
check("new file lands in the task folder", t1.displayPath === join(folder1, "login.tsx"), t1.displayPath);
check("targetKey follows the display path", t1.targetKey === t1.displayPath, t1.targetKey);
check("file really exists inside the folder", existsSync(join(folder1, "login.tsx")));
check("file is not at the old path", !existsSync(join(ws1, "login.tsx")));
const state1 = JSON.parse(readFileSync(join(ws1, ".dsh-auto-create-folder.json"), "utf8"));
check("folder recorded per session", state1.s1 === "构建登录页面", JSON.stringify(state1));

// relative sub path is preserved
const t2 = await toolWrite(env, s1, "src/ui/panel.tsx", "y");
check("relative sub path preserved", t2.displayPath === join(folder1, "src", "ui", "panel.tsx"), t2.displayPath);
check("sub path file exists", existsSync(t2.displayPath));

// the same session keeps using the same folder
const t3 = await toolWrite(env, s1, join(ws1, "second.txt"), "z");
check("same session reuses one folder", t3.displayPath === join(folder1, "second.txt"), t3.displayPath);

// ---- 4. skipped cases --------------------------------------------------
const existing = join(ws1, "keep.txt");
writeFileSync(existing, "old");
const t4 = await toolWrite(env, s1, existing, "new");
check("existing file is not moved", t4.displayPath === existing, t4.displayPath);
check("existing file keeps its content", readFileSync(existing, "utf8") === "new");
const t5 = await toolWrite(env, s1, OUTSIDE, "o");
check("path outside the workspace is untouched", t5.displayPath === OUTSIDE, t5.displayPath);
check("outside file written", existsSync(OUTSIDE));
const inside = await toolWrite(env, s1, join(folder1, "already.txt"), "a");
check("path already inside the folder is untouched", inside.displayPath === join(folder1, "already.txt"), inside.displayPath);
const t6 = await toolWrite(env, s1, join(ws1, "edited.txt"), "e", "edit");
check("edit tool targeting a new path is redirected too", t6.displayPath === join(folder1, "edited.txt"), t6.displayPath);

// ---- 5. disabled --------------------------------------------------------
let live = true;
const offEnv = setup({ enabled: { get: () => live } });
const ws2 = newWorkspace();
const s2 = makeSession(ws2, [titleEvent("关闭状态")], "s2");
const off1 = await toolWrite(offEnv, s2, join(ws2, "a.txt"), "1");
check("live ref true redirects", off1.displayPath === join(ws2, "关闭状态", "a.txt"), off1.displayPath);
live = false;
const off2 = await toolWrite(offEnv, s2, join(ws2, "b.txt"), "2");
check("live ref false does not redirect", off2.displayPath === join(ws2, "b.txt"), off2.displayPath);
live = true;
const off3 = await toolWrite(offEnv, s2, join(ws2, "c.txt"), "3");
check("re-enabling redirects into the same folder", off3.displayPath === join(ws2, "关闭状态", "c.txt"), off3.displayPath);
const plainOff = setup(false);
const ws3 = newWorkspace();
const s3 = makeSession(ws3, [titleEvent("false")], "s3");
const off4 = await toolWrite(plainOff, s3, join(ws3, "d.txt"), "4");
check("plain false value disables", off4.displayPath === join(ws3, "d.txt"), off4.displayPath);
const emptyEnv = setup({});
const ws4 = newWorkspace();
const s4 = makeSession(ws4, [titleEvent("默认开启")], "s4");
const on1 = await toolWrite(emptyEnv, s4, join(ws4, "e.txt"), "5");
check("absent config stays enabled", on1.displayPath === join(ws4, "默认开启", "e.txt"), on1.displayPath);

// ---- 6. names -----------------------------------------------------------
const env2 = setup();
const ws5 = newWorkspace();
const s5 = makeSession(ws5, [titleEvent("构建 登录:页面")], "s5");
const n1 = await toolWrite(env2, s5, join(ws5, "x.txt"), "1");
check("invalid characters sanitized", n1.displayPath === join(ws5, "构建 登录_页面", "x.txt"), n1.displayPath);
const ws6 = newWorkspace();
const longTitle = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const s6 = makeSession(ws6, [titleEvent(longTitle)], "s6");
const n2 = await toolWrite(env2, s6, join(ws6, "y.txt"), "1");
const longName = n2.displayPath.slice(ws6.length + 1, n2.displayPath.length - 6);
check("folder name truncated to 40", longName.length === 40, longName + " len=" + longName.length);
check("truncation keeps the prefix", longTitle.startsWith(longName), longName);
const ws7 = newWorkspace();
mkdirSync(join(ws7, "同名任务"));
const s7 = makeSession(ws7, [titleEvent("同名任务")], "s7");
const n3 = await toolWrite(env2, s7, join(ws7, "z.txt"), "1");
check("an existing folder is reused, not duplicated", n3.displayPath === join(ws7, "同名任务", "z.txt"), n3.displayPath);
check("no sibling folder was created", !existsSync(join(ws7, "同名任务-2")));
const ws7b = newWorkspace();
mkdirSync(join(ws7b, "同名任务"));
writeFileSync(join(ws7b, ".dsh-auto-create-folder.json"), JSON.stringify({ other: "同名任务" }));
const s7b = makeSession(ws7b, [titleEvent("同名任务")], "s7b");
const n3b = await toolWrite(env2, s7b, join(ws7b, "z.txt"), "1");
check("name claimed by another session gets a suffix", n3b.displayPath === join(ws7b, "同名任务-2", "z.txt"), n3b.displayPath);
const ws7c = newWorkspace();
writeFileSync(join(ws7c, "同名任务"), "not a folder");
const s7c = makeSession(ws7c, [titleEvent("同名任务")], "s7c");
const n3c = await toolWrite(env2, s7c, join(ws7c, "z.txt"), "1");
check("name occupied by a file gets a suffix", n3c.displayPath === join(ws7c, "同名任务-2", "z.txt"), n3c.displayPath);
const ws8 = newWorkspace();
const s8 = makeSession(ws8, [userEvent("这是第一条用户消息，用来命名文件夹")], "s8");
const n4 = await toolWrite(env2, s8, join(ws8, "m.txt"), "1");
check("first user message is the fallback", n4.displayPath === join(ws8, "这是第一条用户消息，用来命名文件夹", "m.txt"), n4.displayPath);
const ws9 = newWorkspace();
const s9 = makeSession(ws9, [], "s9");
const n5 = await toolWrite(env2, s9, join(ws9, "t.txt"), "1");
const parts = [basename(dirname(n5.displayPath))];
check("timestamp fallback folder", /^新任务-[0-9]{8}-[0-9]{6}$/.test(parts[0]), parts[0]);

// ---- 7. the fs instance is replaced by reloads -------------------------
const ws10 = newWorkspace();
const s10 = makeSession(ws10, [titleEvent("重建实例")], "s10");
const replacement = env2.replaceFs();
const exec10 = { name: "write", arguments: { file_path: join(ws10, "r.txt"), content: "1" }, agent: { session: s10 } };
let j = 0;
const next10 = async () => { const fn = env2.listeners[j++]; if (!fn) return undefined; return await fn(exec10, next10); };
await next10();
const t10 = await replacement.resolve(join(ws10, "r.txt"), { cwd: ws10 });
await replacement.writeText(t10, "1", undefined, undefined, undefined);
check("wrapper re-installed on a replaced fs instance", t10.displayPath === join(ws10, "重建实例", "r.txt"), t10.displayPath);

// ---- 9. the umbrella folder the user already gave -----------------------
const ws11 = newWorkspace();
const given11 = join(ws11, "期末大作业");
const s11 = makeSession(ws11, [userEvent("请把所有东西放在 " + given11 + " 里面")], "s11");
const t11 = await toolWrite(env, s11, join(ws11, "main.py"), "1");
check("a folder named in the request wins over the task name", t11.displayPath === join(given11, "main.py"), t11.displayPath);
check("that folder is created on the spot", existsSync(given11));
const state11 = JSON.parse(readFileSync(join(ws11, ".dsh-auto-create-folder.json"), "utf8"));
check("the given folder is recorded for the session", state11.s11 === "期末大作业", JSON.stringify(state11));

const ws12 = newWorkspace();
const given12 = join(ws12, "已存在项目");
mkdirSync(given12, { recursive: true });
writeFileSync(join(given12, "old.txt"), "keep");
const s12 = makeSession(ws12, [userEvent("就在 " + given12 + " 里继续做")], "s12");
const t12 = await toolWrite(env, s12, join(ws12, "b.txt"), "2");
check("an existing given folder is used as is", t12.displayPath === join(given12, "b.txt"), t12.displayPath);
check("files already inside it are untouched", existsSync(join(given12, "old.txt")));

const ws13 = newWorkspace();
const filePath13 = join(ws13, "需求.pdf");
writeFileSync(filePath13, "x");
const s13 = makeSession(ws13, [userEvent("先读 " + filePath13)], "s13");
const t13 = await toolWrite(env, s13, join(ws13, "c.txt"), "3");
check("a path to a file is not mistaken for a folder", dirname(t13.displayPath) !== ws13, t13.displayPath);

const ws14 = newWorkspace();
const s14 = makeSession(ws14, [userEvent("东西都放在 " + ws14 + " 里")], "s14");
const t14 = await toolWrite(env, s14, join(ws14, "d.txt"), "4");
check("naming the workspace root itself means no sub folder", t14.displayPath === join(ws14, "d.txt"), t14.displayPath);

const ws15 = newWorkspace();
const existing15 = join(ws15, "车牌识别");
mkdirSync(existing15, { recursive: true });
const s15 = makeSession(ws15, [userEvent("就在 车牌识别 文件夹里做")], "s15");
const t15 = await toolWrite(env, s15, join(ws15, "detect.py"), "5");
check("an existing folder named in plain words is used", t15.displayPath === join(existing15, "detect.py"), t15.displayPath);

const ws16 = newWorkspace();
const s16 = makeSession(ws16, [userEvent("就在 还没建的文件夹 里做"), titleEvent("新项目")], "s16");
const t16 = await toolWrite(env, s16, join(ws16, "e.txt"), "6");
check("a name that does not exist keeps the task folder", t16.displayPath === join(ws16, "新项目", "e.txt"), t16.displayPath);

try { rmSync(WORK, { recursive: true, force: true }); } catch {}
try { rmSync(OUTSIDE, { force: true }); } catch {}
console.log("PASS " + pass + "  FAIL " + fail);
if (failures.length) { console.log("FAILURES:"); for (const f of failures) console.log(" - " + f); }
process.exit(fail ? 1 : 0);
