/**
 * dsh-auto-folder — before DSH creates a NEW file inside the session workspace,
 * create a folder named after the task (session title / first user message) and
 * place the new file inside it, preserving the relative path.
 *
 * Interception: tool arguments are deep-frozen by the tool pipeline and the fs
 * intent waterfalls do not reach plugin listeners from the scoped agent-preset
 * contexts, so the `fs` service write path is wrapped instead. `resolve` arms the
 * target object while a matching write tool call is pending; `writeText` moves the
 * armed target into the task folder. The wrapper is (re)installed on every tool
 * call because profile reconciles replace the fs service instance.
 */
import z from "@deepseek-ai/schemastery";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

const STATE_FILE = ".dsh-auto-folder.json";
const MAX_NAME = 40;
const MAX_PENDING = 8;
const PENDING_TTL = 300000;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const INVALID_CHARS = "<>:/|?*\\";
const PATCHED = Symbol.for("dsh-auto-folder.patched");

const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
});

/**
 * Read the enable flag from the plugin config. Accepts the config object
 * (`{ enabled }`), a live volatile reference, a plain boolean, or nothing at all;
 * anything but an explicit false keeps the feature on.
 */
function enabledNow(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value !== false;
  if (typeof value === "object") {
    if (typeof value.get === "function") return enabledNow(value.get());
    if ("enabled" in value) return enabledNow(value.enabled);
  }
  return true;
}

function clean(text) {
  let out = "";
  for (const ch of String(text === null || text === undefined ? "" : text)) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

function sanitize(text) {
  let out = "";
  for (const ch of clean(text)) out += INVALID_CHARS.includes(ch) ? "_" : ch;
  out = out.replace(/[. ]+$/g, "").trim();
  if (out.length === 0) return "";
  if (RESERVED.test(out)) out = "_" + out;
  return out;
}

function truncate(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** First user message of the session ("" when there is none). */
function firstUserText(session) {
  try {
    const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
    if (!Array.isArray(events)) return "";
    for (const event of events) {
      if (event?.type !== "user/message" || event?.data?.source?.kind !== "user") continue;
      const blocks = Array.isArray(event.data.content) ? event.data.content : [];
      const text = blocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
      if (text.trim().length > 0) return clean(text);
    }
  } catch {}
  return "";
}

/** Session title, else the first user message, else "". */
function titleOf(session) {
  try {
    const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
    if (Array.isArray(events)) {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        const title = event?.type === "session/title" ? event?.data?.title : undefined;
        if (typeof title === "string" && title.trim().length > 0) return clean(title);
      }
    }
  } catch {}
  return firstUserText(session);
}

const ABS_PATH = /[A-Za-z]:[\\/][^\s"'`<>|?*]+/g;
const CUE = /(?:在|到|放进|放在|放到|存入|存到|就在)\s*([^\s"'「」『』，。;；,.:<>/\\|?*]{1,80})/g;
const QUOTED = /["'「『]([^"'「」『』\n]{1,80})["'」』]/g;

/** A folder the user already named in the request, when it lives inside the workspace. */
function mentionedFolder(text, root) {
  const names = [];
  for (const re of [CUE, QUOTED]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) names.push(m[1].trim());
  }
  for (const raw of names) {
    const name = raw.replace(/(文件夹|目录|里面|里边|里|中|内|下)+$/g, "").trim();
    if (name.length === 0) continue;
    try {
      const p = join(root, name);
      if (statSync(p).isDirectory()) return p;
    } catch {}
  }
  return undefined;
}

/**
 * The umbrella folder the user already gave ("就在 D:\\...\\xxx 里做", "放在 xxx 文件夹里").
 * Absolute paths win; otherwise an existing folder mentioned by name. Undefined when none.
 */
function givenFolder(session, root) {
  const text = firstUserText(session);
  if (text.length === 0) return undefined;
  const found = text.match(ABS_PATH) || [];
  for (const raw of found) {
    const p = resolvePath(raw.replace(/[\\/]+$/, ""));
    if (!isInside(p, root)) continue;
    let stat;
    try { stat = statSync(p); } catch {}
    if (stat) {
      if (stat.isDirectory()) return p;
      continue;
    }
    if (extname(p) === "" && existsSync(dirname(p))) return p;
  }
  return mentionedFolder(text, root);
}

/** Folder name for a session: its title, else its first user message, else a timestamp. */
function deriveName(session) {
  const named = truncate(sanitize(titleOf(session)), MAX_NAME);
  return named.length > 0 ? named : "新任务-" + stamp();
}

/** True when child is parent itself or lives below parent. */
function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

function readState(cwd) {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, STATE_FILE), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(cwd, state) {
  try {
    writeFileSync(join(cwd, STATE_FILE), JSON.stringify(state, null, 2));
  } catch {}
}

/**
 * Folder for this session. The recorded name wins. Otherwise the derived name is
 * REUSED when a directory with that name already exists — an existing place is never
 * duplicated, whoever created it. A numeric suffix is only added when the name is
 * already claimed by another session or occupied by a file.
 */
function folderFor(cwd, key, baseName, session) {
  const state = readState(cwd);
  const known = state[key];
  if (typeof known === "string" && known.length > 0) {
    const path = join(cwd, known);
    try { mkdirSync(path, { recursive: true }); } catch {}
    return path;
  }
  const given = givenFolder(session, cwd);
  if (given) {
    try { mkdirSync(given, { recursive: true }); } catch {}
    state[key] = relative(cwd, given) || ".";
    writeState(cwd, state);
    return given;
  }
  const taken = new Set(Object.entries(state).filter(([k]) => k !== key).map(([, v]) => v));
  let name = baseName;
  let n = 2;
  while (taken.has(name) || occupiedByFile(cwd, name)) name = baseName + "-" + n++;
  const path = join(cwd, name);
  mkdirSync(path, { recursive: true });
  state[key] = name;
  writeState(cwd, state);
  return path;
}

/** True when the path exists but is not a directory (a reusable directory is not occupied). */
function occupiedByFile(cwd, name) {
  try {
    return !statSync(join(cwd, name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Plugin entry: gate on config.enabled, remember the session of every write tool
 * call, and wrap the fs service so armed targets move into the task folder.
 */
function apply(ctx, config) {
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });

  const pending = [];
  const patched = new WeakSet();
  let fsContext = null;

  function pushPending(exec) {
    const session = exec?.agent?.session;
    const cwd = session?.header?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) return;
    pending.push({
      key: session?.id ?? cwd,
      cwd: resolvePath(cwd),
      session,
      at: Date.now(),
    });
    while (pending.length > MAX_PENDING) pending.shift();
  }

  function takePending(cwdHint) {
    const now = Date.now();
    for (let i = pending.length - 1; i >= 0; i--) {
      if (now - pending[i].at > PENDING_TTL) pending.splice(i, 1);
    }
    if (pending.length === 0) return undefined;
    if (typeof cwdHint === "string" && cwdHint.length > 0) {
      const want = resolvePath(cwdHint);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].cwd === want) return pending.splice(i, 1)[0];
      }
    }
    return pending.pop();
  }

  /** Move a newly created file into the task folder of the session that armed it. */
  function redirectArmed(target, entry) {
    if (!entry || !enabledNow(config)) return;
    if (typeof target.displayPath !== "string" || target.displayPath.length === 0) return;
    const root = entry.cwd;
    const abs = resolvePath(target.displayPath);
    if (!isInside(abs, root) || abs === root) return;
    if (existsSync(abs)) return;
    const folder = folderFor(root, entry.key, deriveName(entry.session), entry.session);
    if (isInside(abs, folder)) return;
    const moved = join(folder, relative(root, abs));
    try { mkdirSync(dirname(moved), { recursive: true }); } catch {}
    target.displayPath = moved;
    target.targetKey = moved;
  }

  /** Wrap the current fs service instance once (instances are replaced by reloads). */
  function ensurePatched() {
    const service = fsContext?.fs;
    if (!service || typeof service.resolve !== "function" || typeof service.writeText !== "function") return;
    if (patched.has(service)) return;
    patched.add(service);
    try { service[PATCHED] = true; } catch {}
    const originalResolve = service.resolve;
    const originalWriteText = service.writeText;
    const originalEditText = typeof service.editText === "function" ? service.editText : undefined;
    const armed = new WeakMap();
    service.resolve = async function (path, options) {
      const entry = enabledNow(config) ? takePending(options?.cwd) : undefined;
      const target = await originalResolve.call(this, path, options);
      if (entry && target !== null && typeof target === "object") armed.set(target, entry);
      return target;
    };
    service.writeText = async function (target, content, intent, signal, policy) {
      try { redirectArmed(target, armed.get(target)); } catch {}
      return originalWriteText.call(this, target, content, intent, signal, policy);
    };
    if (originalEditText) {
      service.editText = function (target, change, intent, signal, policy) {
        armed.delete(target);
        return originalEditText.call(this, target, change, intent, signal, policy);
      };
    }
  }

  ctx.inject(["fs"], (child) => {
    fsContext = child;
    ensurePatched();
  });

  ctx.on("tools/execute", (exec, next) => {
    try {
      const name = exec?.name;
      if (name === "write" || name === "edit" || name === "str_replace_editor") pushPending(exec);
      ensurePatched();
    } catch {}
    return next();
  });
}

export { Config, apply };
